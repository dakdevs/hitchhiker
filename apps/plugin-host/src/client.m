#import <Foundation/Foundation.h>
#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <unistd.h>
#include <xpc/xpc.h>

static const NSUInteger MAX_LINE_BYTES = 1024 * 1024;
static const NSUInteger MAX_CODE_BYTES = 512 * 1024;
static const NSUInteger MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
enum { MAX_IDENTITY_ATTEMPTS = 20 };

typedef struct OutputItem {
  void *bytes;
  size_t length;
  struct OutputItem *next;
} OutputItem;

typedef struct {
  pthread_mutex_t lock;
  pthread_cond_t ready;
  OutputItem *head;
  OutputItem *tail;
  size_t bytes;
  BOOL closed;
  atomic_bool closing;
  xpc_connection_t connection;
  dispatch_queue_t lifecycle_queue;
  pid_t worker_pid;
  uint64_t worker_generation;
  uint64_t worker_start_abstime;
  BOOL worker_identity_available;
  BOOL resource_kill_requested;
  BOOL identity_retry_scheduled;
  NSUInteger identity_attempts;
  BOOL lifecycle_protocol_failed;
} OutputQueue;

static void enqueue_object(OutputQueue *queue, NSDictionary *object);
static void establish_worker_identity(OutputQueue *queue, pid_t pid, uint64_t generation);

static BOOL positive_integer(id value) {
  if (![value isKindOfClass:NSNumber.class] ||
      value == (__bridge id)kCFBooleanTrue || value == (__bridge id)kCFBooleanFalse)
    return NO;
  double number = [value doubleValue];
  return isfinite(number) && number >= 1 && number <= 9007199254740991.0 && floor(number) == number;
}

static BOOL positive_uint64_string(id value, uint64_t *result) {
  if (![value isKindOfClass:NSString.class] || [(NSString *)value length] == 0) return NO;
  NSString *string = value;
  if ([string characterAtIndex:0] == '0') return NO;
  uint64_t number = 0;
  for (NSUInteger index = 0; index < string.length; index++) {
    unichar character = [string characterAtIndex:index];
    if (character < '0' || character > '9') return NO;
    uint64_t digit = (uint64_t)(character - '0');
    if (number > (UINT64_MAX - digit) / 10) return NO;
    number = number * 10 + digit;
  }
  if (number == 0) return NO;
  *result = number;
  return YES;
}

static BOOL exact_keys(NSDictionary *object, NSArray<NSString *> *keys) {
  if (object.count != keys.count) return NO;
  for (NSString *key in keys)
    if (object[key] == nil) return NO;
  return YES;
}

static NSDictionary *identity_object(pid_t pid, uint64_t generation, uint64_t start_abstime) {
  return @{
    @"pid" : @(pid),
    @"generation" : @(generation),
    @"startAbstime" : [NSString stringWithFormat:@"%llu", start_abstime],
  };
}

static void enqueue_host_control(OutputQueue *queue, NSDictionary *control) {
  enqueue_object(queue, @{ @"hostControl" : control });
}

static void emit_diagnostic_failure(OutputQueue *queue, NSNumber *identifier, NSString *code) {
  if (!positive_integer(identifier)) return;
  enqueue_host_control(queue, @{
    @"id" : identifier,
    @"error" : @{ @"code" : code },
  });
}

static BOOL diagnostic_sample_request(NSDictionary *request, NSNumber **identifier,
                                      pid_t *pid, uint64_t *generation,
                                      uint64_t *start_abstime) {
  if (!exact_keys(request, @[ @"hostControl" ])) return NO;
  NSDictionary *control = request[@"hostControl"];
  if (![control isKindOfClass:NSDictionary.class] ||
      !exact_keys(control, @[ @"id", @"method", @"identity" ])) return NO;
  NSNumber *request_id = control[@"id"];
  NSDictionary *identity = control[@"identity"];
  if (!positive_integer(request_id) || ![control[@"method"] isEqual:@"worker.sample"] ||
      ![identity isKindOfClass:NSDictionary.class] ||
      !exact_keys(identity, @[ @"pid", @"generation", @"startAbstime" ]) ||
      !positive_integer(identity[@"pid"]) || !positive_integer(identity[@"generation"]) ||
      [identity[@"pid"] unsignedLongLongValue] > INT_MAX ||
      !positive_uint64_string(identity[@"startAbstime"], start_abstime))
    return NO;
  *identifier = request_id;
  *pid = (pid_t)[identity[@"pid"] intValue];
  *generation = [identity[@"generation"] unsignedLongLongValue];
  return YES;
}

static BOOL current_identity_locked(OutputQueue *queue, pid_t pid, uint64_t generation,
                                    uint64_t start_abstime) {
  return queue->worker_identity_available && queue->worker_pid == pid &&
         queue->worker_generation == generation &&
         queue->worker_start_abstime == start_abstime;
}

static void emit_lifecycle_protocol_failure(OutputQueue *queue) {
  pthread_mutex_lock(&queue->lock);
  BOOL first_failure = !queue->lifecycle_protocol_failed;
  queue->lifecycle_protocol_failed = YES;
  pthread_mutex_unlock(&queue->lock);
  if (first_failure)
    enqueue_object(queue, @{
      @"event" : @"plugin.crash",
      @"params" : @{ @"reason" : @"broker_lifecycle_protocol" }
    });
}

static void handle_diagnostic_sample(OutputQueue *queue, NSNumber *identifier, pid_t pid,
                                     uint64_t generation, uint64_t start_abstime) {
  pthread_mutex_lock(&queue->lock);
  BOOL bound = queue->worker_pid == pid && queue->worker_generation == generation;
  BOOL current = bound && current_identity_locked(queue, pid, generation, start_abstime);
  BOOL unavailable = bound && !queue->worker_identity_available;
  pthread_mutex_unlock(&queue->lock);
  if (!current) {
    emit_diagnostic_failure(queue, identifier, unavailable ? @"unavailable" : @"stale_worker");
    return;
  }
  struct rusage_info_v4 usage = {0};
  if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) {
    emit_diagnostic_failure(queue, identifier, @"unavailable");
    return;
  }
  pthread_mutex_lock(&queue->lock);
  current = current_identity_locked(queue, pid, generation, start_abstime) &&
            usage.ri_proc_start_abstime == start_abstime;
  pthread_mutex_unlock(&queue->lock);
  if (!current) {
    emit_diagnostic_failure(queue, identifier, @"stale_worker");
    return;
  }
  if (usage.ri_phys_footprint > 9007199254740991ULL ||
      usage.ri_resident_size > 9007199254740991ULL) {
    emit_diagnostic_failure(queue, identifier, @"unavailable");
    return;
  }
  enqueue_host_control(queue, @{
    @"id" : identifier,
    @"result" : @{
      @"identity" : identity_object(pid, generation, start_abstime),
      @"physicalFootprintBytes" : @(usage.ri_phys_footprint),
      @"residentBytes" : @(usage.ri_resident_size),
    },
  });
}

static void establish_worker_identity(OutputQueue *queue, pid_t pid, uint64_t generation) {
  struct rusage_info_v4 usage = {0};
  BOOL sampled = proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) == 0 &&
                 usage.ri_proc_start_abstime != 0;
  pthread_mutex_lock(&queue->lock);
  BOOL current = queue->worker_pid == pid && queue->worker_generation == generation;
  BOOL established = current && !queue->worker_identity_available && sampled;
  if (established) {
    queue->worker_start_abstime = usage.ri_proc_start_abstime;
    queue->worker_identity_available = YES;
  }
  if (current && !established && !queue->worker_identity_available &&
      queue->identity_attempts < MAX_IDENTITY_ATTEMPTS)
    queue->identity_attempts++;
  queue->identity_retry_scheduled = NO;
  pthread_mutex_unlock(&queue->lock);
  if (established)
    enqueue_host_control(queue, @{
      @"event" : @"worker.started",
      @"identity" : identity_object(pid, generation, usage.ri_proc_start_abstime),
    });
}

static BOOL write_all(int descriptor, const void *bytes, size_t length) {
  const uint8_t *cursor = bytes;
  while (length > 0) {
    ssize_t written = write(descriptor, cursor, length);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return NO;
    cursor += written;
    length -= (size_t)written;
  }
  return YES;
}

static BOOL enqueue(OutputQueue *queue, NSData *line) {
  if (!line || line.length + 1 > MAX_LINE_BYTES) return NO;
  OutputItem *item = calloc(1, sizeof(OutputItem));
  item->length = line.length + 1;
  item->bytes = malloc(item->length);
  memcpy(item->bytes, line.bytes, line.length);
  ((uint8_t *)item->bytes)[line.length] = '\n';
  pthread_mutex_lock(&queue->lock);
  if (queue->closed || queue->bytes + item->length > MAX_OUTPUT_BYTES) {
    BOOL overflowed = !queue->closed;
    pthread_mutex_unlock(&queue->lock);
    free(item->bytes); free(item);
    if (overflowed) _exit(75);
    return NO;
  }
  if (queue->tail) queue->tail->next = item;
  else queue->head = item;
  queue->tail = item;
  queue->bytes += item->length;
  pthread_cond_signal(&queue->ready);
  pthread_mutex_unlock(&queue->lock);
  return YES;
}

static void enqueue_object(OutputQueue *queue, NSDictionary *object) {
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  enqueue(queue, encoded);
}

static void *write_output(void *opaque) {
  OutputQueue *queue = opaque;
  for (;;) {
    pthread_mutex_lock(&queue->lock);
    while (!queue->head && !queue->closed) pthread_cond_wait(&queue->ready, &queue->lock);
    OutputItem *item = queue->head;
    if (!item && queue->closed) { pthread_mutex_unlock(&queue->lock); break; }
    queue->head = item->next;
    if (!queue->head) queue->tail = NULL;
    pthread_mutex_unlock(&queue->lock);
    if (!write_all(STDOUT_FILENO, item->bytes, item->length)) {
      free(item->bytes); free(item);
      pthread_mutex_lock(&queue->lock);
      queue->closed = YES;
      pthread_mutex_unlock(&queue->lock);
      break;
    }
    pthread_mutex_lock(&queue->lock);
    queue->bytes -= item->length;
    pthread_mutex_unlock(&queue->lock);
    free(item->bytes); free(item);
  }
  return NULL;
}

static void *watch_memory(void *opaque) {
  OutputQueue *state = opaque;
  for (;;) {
    usleep(10000);
    if (atomic_load(&state->closing)) break;
    pthread_mutex_lock(&state->lock);
    pid_t pid = state->worker_pid;
    uint64_t generation = state->worker_generation;
    BOOL identity_available = state->worker_identity_available;
    BOOL retry_identity = pid > 0 && !identity_available &&
                          !state->identity_retry_scheduled &&
                          state->identity_attempts < MAX_IDENTITY_ATTEMPTS;
    if (retry_identity) state->identity_retry_scheduled = YES;
    pthread_mutex_unlock(&state->lock);
    if (retry_identity)
      dispatch_async(state->lifecycle_queue, ^{
        establish_worker_identity(state, pid, generation);
      });
    if (pid <= 0) continue;
    struct rusage_info_v4 usage = {0};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0 ||
        usage.ri_phys_footprint <= 150ULL * 1024ULL * 1024ULL)
      continue;
    pthread_mutex_lock(&state->lock);
    BOOL current = state->worker_pid == pid && state->worker_generation == generation &&
                   (!state->worker_identity_available ||
                    usage.ri_proc_start_abstime == state->worker_start_abstime);
    BOOL should_kill = current && !state->resource_kill_requested;
    if (should_kill) state->resource_kill_requested = YES;
    pthread_mutex_unlock(&state->lock);
    if (!should_kill) continue;
    xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_uint64(message, "killGeneration", generation);
    xpc_dictionary_set_uint64(message, "rssBytes", usage.ri_phys_footprint);
    xpc_connection_send_message(state->connection, message);
  }
  return NULL;
}

static NSData *read_line(BOOL *eof, BOOL *oversized) {
  NSMutableData *line = [NSMutableData dataWithCapacity:4096];
  *eof = NO;
  *oversized = NO;
  uint8_t byte = 0;
  for (;;) {
    ssize_t count = read(STDIN_FILENO, &byte, 1);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { *eof = YES; return line.length > 0 ? line : nil; }
    if (byte == '\n') return line;
    if (line.length < MAX_LINE_BYTES) [line appendBytes:&byte length:1];
    else *oversized = YES;
  }
}

static NSDictionary *error_reply(NSNumber *identifier, NSString *code, NSString *message) {
  return @{
    @"id" : identifier ?: @0,
    @"error" : @{ @"code" : code, @"message" : message }
  };
}

static BOOL valid_request(NSDictionary *request, NSString **message) {
  NSNumber *identifier = request[@"id"];
  NSString *method = request[@"method"];
  NSDictionary *params = request[@"params"];
  if (!positive_integer(identifier) ||
      ![method isKindOfClass:NSString.class] || ![params isKindOfClass:NSDictionary.class]) {
    *message = @"Request must contain positive integer id, method, and object params";
    return NO;
  }
  if ([method isEqualToString:@"activate"]) {
    if (![params[@"code"] isKindOfClass:NSString.class] ||
        [params[@"code"] lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > MAX_CODE_BYTES) {
      *message = @"activate requires code no larger than 512 KiB";
      return NO;
    }
    return YES;
  }
  if ([method isEqualToString:@"event"]) {
    if (![params[@"event"] isKindOfClass:NSString.class] || params[@"payload"] == nil) {
      *message = @"event requires an event name and JSON payload";
      return NO;
    }
    return YES;
  }
  if ([method isEqualToString:@"resolve"]) {
    BOOL has_result = params[@"result"] != nil;
    BOOL has_error = params[@"error"] != nil;
    if (!positive_integer(params[@"callId"]) || has_result == has_error) {
      *message = @"resolve requires callId and exactly one of result or error";
      return NO;
    }
    return YES;
  }
  if ([method isEqualToString:@"stop"]) {
    if (params.count != 0) { *message = @"stop params must be empty"; return NO; }
    return YES;
  }
  *message = @"Unknown method";
  return NO;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    (void)argv;
    if (argc != 1) {
      fprintf(stderr, "plugin-host accepts no command-line arguments\n");
      return 64;
    }
    OutputQueue *output = calloc(1, sizeof(OutputQueue));
    pthread_mutex_init(&output->lock, NULL);
    pthread_cond_init(&output->ready, NULL);
    pthread_t writer;
    pthread_create(&writer, NULL, write_output, output);

    dispatch_queue_t lifecycle_queue = dispatch_queue_create(
      "dev.hitchhiker.PluginHost.Client.lifecycle", DISPATCH_QUEUE_SERIAL);
    output->lifecycle_queue = lifecycle_queue;
    xpc_connection_t connection = xpc_connection_create(
      "dev.hitchhiker.PluginHost.Broker", lifecycle_queue);
    output->connection = connection;
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
      @autoreleasepool {
        if (xpc_get_type(event) == XPC_TYPE_DICTIONARY) {
          BOOL has_start = xpc_dictionary_get_value(event, "workerPid") != NULL;
          BOOL has_stop = xpc_dictionary_get_value(event, "workerStopped") != NULL;
          if (has_start && has_stop) {
            emit_lifecycle_protocol_failure(output);
          } else if (has_start) {
            pid_t pid = (pid_t)xpc_dictionary_get_int64(event, "workerPid");
            uint64_t generation = xpc_dictionary_get_uint64(event, "generation");
            if (pid <= 0 || generation == 0) {
              emit_lifecycle_protocol_failure(output);
              return;
            }
            pthread_mutex_lock(&output->lock);
            BOOL empty = output->worker_pid == 0;
            if (empty) {
              output->worker_pid = pid;
              output->worker_generation = generation;
              output->worker_start_abstime = 0;
              output->worker_identity_available = NO;
              output->resource_kill_requested = NO;
              output->identity_retry_scheduled = NO;
              output->identity_attempts = 0;
            }
            pthread_mutex_unlock(&output->lock);
            if (!empty) {
              emit_lifecycle_protocol_failure(output);
              return;
            }
            establish_worker_identity(output, pid, generation);
          } else if (has_stop) {
            pid_t pid = (pid_t)xpc_dictionary_get_int64(event, "workerStopped");
            uint64_t generation = xpc_dictionary_get_uint64(event, "generation");
            if (pid <= 0 || generation == 0) {
              emit_lifecycle_protocol_failure(output);
              return;
            }
            pthread_mutex_lock(&output->lock);
            BOOL current = output->worker_pid == pid && output->worker_generation == generation;
            BOOL available = current && output->worker_identity_available;
            uint64_t start_abstime = output->worker_start_abstime;
            if (current) {
              output->worker_pid = 0;
              output->worker_generation = 0;
              output->worker_start_abstime = 0;
              output->worker_identity_available = NO;
              output->resource_kill_requested = NO;
              output->identity_retry_scheduled = NO;
              output->identity_attempts = 0;
            }
            pthread_mutex_unlock(&output->lock);
            if (!current) {
              emit_lifecycle_protocol_failure(output);
              return;
            }
            if (available)
              enqueue_host_control(output, @{
                @"event" : @"worker.stopped",
                @"identity" : identity_object(pid, generation, start_abstime),
              });
          } else {
            size_t length = 0;
            const void *bytes = xpc_dictionary_get_data(event, "line", &length);
            if (bytes && length <= MAX_LINE_BYTES)
              enqueue(output, [NSData dataWithBytes:bytes length:length]);
          }
        } else if (event == XPC_ERROR_CONNECTION_INVALID && !atomic_load(&output->closing)) {
          enqueue_object(output, @{
            @"event" : @"plugin.crash",
            @"params" : @{ @"reason" : @"broker_connection_invalid" }
          });
        }
      }
    });
    xpc_connection_resume(connection);
    pthread_t memory_watchdog;
    pthread_create(&memory_watchdog, NULL, watch_memory, output);

    for (;;) {
      @autoreleasepool {
        BOOL eof = NO, oversized = NO;
        NSData *line = read_line(&eof, &oversized);
        if (!line && eof) break;
        if (!line) continue;
        if (oversized) {
          enqueue_object(output, error_reply(@0, @"frame_too_large", @"Frame exceeds 1 MiB"));
          continue;
        }
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
        if ([request isKindOfClass:NSDictionary.class] && request[@"hostControl"] != nil) {
          NSNumber *identifier = nil;
          pid_t pid = 0;
          uint64_t generation = 0, start_abstime = 0;
          if (diagnostic_sample_request(request, &identifier, &pid, &generation, &start_abstime))
            handle_diagnostic_sample(output, identifier, pid, generation, start_abstime);
          else {
            NSDictionary *control = [request[@"hostControl"] isKindOfClass:NSDictionary.class]
              ? request[@"hostControl"] : nil;
            emit_diagnostic_failure(output, control[@"id"], @"unavailable");
          }
          continue;
        }
        NSString *message = nil;
        if (![request isKindOfClass:NSDictionary.class] || !valid_request(request, &message)) {
          NSNumber *identifier = positive_integer(request[@"id"]) ? request[@"id"] : @0;
          enqueue_object(output,
            error_reply(identifier, @"invalid_request", message ?: @"Malformed JSON"));
          continue;
        }
        xpc_object_t packet = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_data(packet, "line", line.bytes, line.length);
        xpc_connection_send_message(connection, packet);
      }
    }
    atomic_store(&output->closing, true);
    pthread_join(memory_watchdog, NULL);
    xpc_connection_cancel(connection);
    usleep(100000);
    pthread_mutex_lock(&output->lock);
    output->closed = YES;
    pthread_cond_signal(&output->ready);
    pthread_mutex_unlock(&output->lock);
    pthread_join(writer, NULL);
    // The canceled XPC connection can deliver its terminal event asynchronously.
    // Keep this process-lifetime state valid until exit.
    return 0;
  }
}
