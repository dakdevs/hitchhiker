#import <Foundation/Foundation.h>
#include <errno.h>
#include <libproc.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <unistd.h>
#include <xpc/xpc.h>

static const NSUInteger MAX_LINE_BYTES = 1024 * 1024;
static const NSUInteger MAX_CODE_BYTES = 512 * 1024;
static const NSUInteger MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

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
  pid_t worker_pid;
  uint64_t worker_generation;
} OutputQueue;

static BOOL positive_integer(id value) {
  if (![value isKindOfClass:NSNumber.class] ||
      value == (__bridge id)kCFBooleanTrue || value == (__bridge id)kCFBooleanFalse)
    return NO;
  double number = [value doubleValue];
  return isfinite(number) && number >= 1 && number <= 9007199254740991.0 && floor(number) == number;
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
    pthread_mutex_unlock(&state->lock);
    if (pid <= 0) continue;
    struct rusage_info_v4 usage = {0};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0 ||
        usage.ri_phys_footprint <= 150ULL * 1024ULL * 1024ULL)
      continue;
    pthread_mutex_lock(&state->lock);
    BOOL current = state->worker_pid == pid && state->worker_generation == generation;
    if (current) state->worker_pid = 0;
    pthread_mutex_unlock(&state->lock);
    if (!current) continue;
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

    xpc_connection_t connection = xpc_connection_create(
      "dev.hitchhiker.PluginHost.Broker", dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    output->connection = connection;
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
      @autoreleasepool {
        if (xpc_get_type(event) == XPC_TYPE_DICTIONARY) {
          if (xpc_dictionary_get_value(event, "workerPid")) {
            pthread_mutex_lock(&output->lock);
            output->worker_pid = (pid_t)xpc_dictionary_get_int64(event, "workerPid");
            output->worker_generation = xpc_dictionary_get_uint64(event, "generation");
            pthread_mutex_unlock(&output->lock);
          } else if (xpc_dictionary_get_value(event, "workerStopped")) {
            uint64_t generation = xpc_dictionary_get_uint64(event, "generation");
            pthread_mutex_lock(&output->lock);
            if (output->worker_generation == generation) output->worker_pid = 0;
            pthread_mutex_unlock(&output->lock);
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
