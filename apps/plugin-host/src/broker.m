#import <Foundation/Foundation.h>
#include <math.h>
#include <mach-o/dyld.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <xpc/xpc.h>

enum { MAX_COMMANDS = 64 };
static const size_t MAX_LINE_BYTES = 1024 * 1024;
static const uint64_t COMMAND_CPU_LIMIT_MS = 500;
static const uint64_t WORKER_STARTUP_LIMIT_MS = 4000;
static const uint64_t COMMAND_TOTAL_WALL_LIMIT_MS = 5000;
static const uint64_t RSS_LIMIT_BYTES = 150ULL * 1024ULL * 1024ULL;
enum { CPU_ACCOUNTING_EXIT = 76 };

typedef struct {
  int64_t identifier;
  uint64_t deadline_ms;
} CommandDeadline;

typedef struct {
  pthread_mutex_t lock;
  xpc_connection_t peer;
  pid_t worker_pid;
  int worker_input;
  uint64_t generation;
  uint64_t startup_deadline_ms;
  BOOL closing;
  BOOL ready;
  BOOL expected_stop;
  BOOL resource_kill;
  char resource_reason[16];
  CommandDeadline commands[MAX_COMMANDS];
  size_t command_count;
} BrokerState;

typedef struct {
  BrokerState *state;
  pid_t pid;
  int output;
  uint64_t generation;
} WorkerThread;

static BOOL positive_integer(id value) {
  if (![value isKindOfClass:NSNumber.class] ||
      value == (__bridge id)kCFBooleanTrue || value == (__bridge id)kCFBooleanFalse)
    return NO;
  double number = [value doubleValue];
  return isfinite(number) && number >= 1 && number <= 9007199254740991.0 && floor(number) == number;
}

static uint64_t now_ms(void) {
  struct timespec time = {0};
  clock_gettime(CLOCK_MONOTONIC, &time);
  return (uint64_t)time.tv_sec * 1000ULL + (uint64_t)time.tv_nsec / 1000000ULL;
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

static BOOL inspect_worker_exit(pid_t pid, siginfo_t *info) {
  for (;;) {
    if (waitid(P_PID, (id_t)pid, info, WEXITED | WNOWAIT) == 0) return YES;
    if (errno != EINTR) return NO;
  }
}

static void send_data(BrokerState *state, NSData *line) {
  if (!line || line.length > MAX_LINE_BYTES) return;
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_data(message, "line", line.bytes, line.length);
  xpc_connection_send_message(state->peer, message);
}

static void send_worker_state(BrokerState *state, const char *key, pid_t pid,
                              uint64_t generation) {
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_int64(message, key, pid);
  xpc_dictionary_set_uint64(message, "generation", generation);
  xpc_connection_send_message(state->peer, message);
}

static void send_object(BrokerState *state, NSDictionary *object) {
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  send_data(state, encoded);
}

static void send_resource(BrokerState *state, NSString *reason, uint64_t rss) {
  send_object(state, @{
    @"event" : @"plugin.resource",
    @"params" : @{
      @"reason" : reason,
      @"rssBytes" : @(rss),
      @"rssLimitBytes" : @(RSS_LIMIT_BYTES),
      @"commandLimitMs" : @(COMMAND_CPU_LIMIT_MS),
      @"cpuLimitMs" : @(COMMAND_CPU_LIMIT_MS),
      @"startupLimitMs" : @(WORKER_STARTUP_LIMIT_MS),
      @"commandWallLimitMs" : @(COMMAND_TOTAL_WALL_LIMIT_MS),
    }
  });
}

static NSDictionary *error_reply(NSNumber *identifier, NSString *code, NSString *message) {
  return @{
    @"id" : identifier ?: @0,
    @"error" : @{ @"code" : code, @"message" : message }
  };
}

static void remove_command_locked(BrokerState *state, int64_t identifier) {
  for (size_t index = 0; index < state->command_count; index++) {
    if (state->commands[index].identifier == identifier) {
      state->commands[index] = state->commands[state->command_count - 1];
      state->command_count--;
      return;
    }
  }
}

static void wait_command_locked(BrokerState *state, int64_t identifier) {
  for (size_t index = 0; index < state->command_count; index++)
    if (state->commands[index].identifier == identifier) return;
}

static BOOL add_command_locked(BrokerState *state, int64_t identifier) {
  if (state->command_count >= MAX_COMMANDS) return NO;
  for (size_t index = 0; index < state->command_count; index++)
    if (state->commands[index].identifier == identifier) return NO;
  state->commands[state->command_count++] = (CommandDeadline){
    .identifier = identifier,
    .deadline_ms = now_ms() + COMMAND_TOTAL_WALL_LIMIT_MS,
  };
  return YES;
}

static NSString *fixed_worker_path(void) {
  char executable[PATH_MAX] = {0};
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) return nil;
  char *separator = strrchr(executable, '/');
  if (!separator) return nil;
  strcpy(separator + 1, "plugin-worker");
  return [NSString stringWithUTF8String:executable];
}

static void kill_worker_locked(BrokerState *state, NSString *reason) {
  if (state->worker_pid <= 0 || state->resource_kill) return;
  state->resource_kill = YES;
  snprintf(state->resource_reason, sizeof(state->resource_reason), "%s", reason.UTF8String);
  kill(-state->worker_pid, SIGKILL);
}

static void *watch_worker(void *opaque) {
  WorkerThread *thread = opaque;
  BrokerState *state = thread->state;
  for (;;) {
    usleep(10000);
    pthread_mutex_lock(&state->lock);
    if (state->closing || state->generation != thread->generation ||
        state->worker_pid != thread->pid) {
      pthread_mutex_unlock(&state->lock);
      break;
    }
    uint64_t current = now_ms();
    BOOL startup_deadline = state->startup_deadline_ms > 0 &&
                            state->startup_deadline_ms <= current;
    BOOL command_deadline = NO;
    for (size_t index = 0; index < state->command_count; index++)
      if (state->commands[index].deadline_ms > 0 &&
          state->commands[index].deadline_ms <= current)
        command_deadline = YES;
    if (startup_deadline || command_deadline) {
      NSString *reason = startup_deadline ? @"startup-wall" : @"wall";
      send_resource(state, reason, 0);
      kill_worker_locked(state, reason);
      pthread_mutex_unlock(&state->lock);
      break;
    }
    pthread_mutex_unlock(&state->lock);
  }
  free(thread);
  return NULL;
}

static void forward_worker_line(WorkerThread *thread, NSData *line) {
  BrokerState *state = thread->state;
  NSDictionary *object = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
  NSNumber *identifier = [object isKindOfClass:NSDictionary.class] ? object[@"id"] : nil;
  NSString *control = [object isKindOfClass:NSDictionary.class] ? object[@"control"] : nil;
  NSString *event = [object isKindOfClass:NSDictionary.class] ? object[@"event"] : nil;
  if ([event isEqualToString:@"plugin.started"]) {
    BOOL valid = [object[@"params"] isKindOfClass:NSDictionary.class];
    pthread_mutex_lock(&state->lock);
    valid = valid && state->generation == thread->generation &&
            state->worker_pid == thread->pid && !state->ready;
    if (valid) {
      state->ready = YES;
      state->startup_deadline_ms = 0;
    } else if (state->generation == thread->generation && state->worker_pid == thread->pid) {
      kill_worker_locked(state, @"protocol");
    }
    pthread_mutex_unlock(&state->lock);
    if (valid) send_data(state, line);
    return;
  }
  pthread_mutex_lock(&state->lock);
  BOOL before_ready = state->generation == thread->generation &&
                      state->worker_pid == thread->pid && !state->ready;
  if (before_ready) kill_worker_locked(state, @"protocol");
  pthread_mutex_unlock(&state->lock);
  if (before_ready) return;
  if ([control isEqualToString:@"command.wait"] && positive_integer(identifier)) {
    pthread_mutex_lock(&state->lock);
    if (state->generation == thread->generation)
      wait_command_locked(state, identifier.longLongValue);
    pthread_mutex_unlock(&state->lock);
    return;
  }
  if ([identifier isKindOfClass:NSNumber.class]) {
    pthread_mutex_lock(&state->lock);
    if (state->generation == thread->generation)
      remove_command_locked(state, identifier.longLongValue);
    pthread_mutex_unlock(&state->lock);
  }
  send_data(state, line);
}

static void *read_worker(void *opaque) {
  WorkerThread *thread = opaque;
  BrokerState *state = thread->state;
  NSMutableData *line = [NSMutableData dataWithCapacity:4096];
  BOOL oversized = NO;
  uint8_t buffer[8192];
  for (;;) {
    ssize_t count = read(thread->output, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) break;
    for (ssize_t index = 0; index < count; index++) {
      if (buffer[index] == '\n') {
        if (oversized) {
          pthread_mutex_lock(&state->lock);
          kill_worker_locked(state, @"protocol");
          pthread_mutex_unlock(&state->lock);
        } else {
          @autoreleasepool { forward_worker_line(thread, [line copy]); }
        }
        [line setLength:0];
        oversized = NO;
      } else if (line.length < MAX_LINE_BYTES) {
        [line appendBytes:&buffer[index] length:1];
      } else {
        oversized = YES;
      }
    }
  }
  close(thread->output);
  siginfo_t exit_info = {0};
  BOOL inspected = inspect_worker_exit(thread->pid, &exit_info);
  BOOL cpu_exit = inspected && exit_info.si_code == CLD_KILLED &&
                  exit_info.si_status == SIGPROF;
  BOOL accounting_exit = inspected && exit_info.si_code == CLD_EXITED &&
                         exit_info.si_status == CPU_ACCOUNTING_EXIT;
  if (cpu_exit || accounting_exit) kill(-thread->pid, SIGKILL);
  int status = 0;
  while (waitpid(thread->pid, &status, 0) < 0 && errno == EINTR) {}
  if (!inspected) {
    cpu_exit = WIFSIGNALED(status) && WTERMSIG(status) == SIGPROF;
    accounting_exit = WIFEXITED(status) && WEXITSTATUS(status) == CPU_ACCOUNTING_EXIT;
  }

  int64_t failed[MAX_COMMANDS] = {0};
  size_t failed_count = 0;
  BOOL expected = NO, resource = NO, current = NO, report_resource = NO;
  char reason[16] = {0};
  pthread_mutex_lock(&state->lock);
  current = state->generation == thread->generation && state->worker_pid == thread->pid;
  if (current) {
    send_worker_state(state, "workerStopped", thread->pid, thread->generation);
    close(state->worker_input);
    state->worker_input = -1;
    state->worker_pid = 0;
    expected = state->expected_stop;
    resource = state->resource_kill;
    snprintf(reason, sizeof(reason), "%s", state->resource_reason);
    if (!resource && cpu_exit) {
      resource = YES;
      report_resource = YES;
      snprintf(reason, sizeof(reason), "%s", "cpu");
    } else if (!resource && accounting_exit) {
      resource = YES;
      report_resource = YES;
      snprintf(reason, sizeof(reason), "%s", "cpu-accounting");
    }
    failed_count = state->command_count;
    for (size_t index = 0; index < failed_count; index++)
      failed[index] = state->commands[index].identifier;
    state->command_count = 0;
    state->ready = NO;
    state->startup_deadline_ms = 0;
    state->expected_stop = NO;
    state->resource_kill = NO;
    state->resource_reason[0] = 0;
  }
  pthread_mutex_unlock(&state->lock);
  if (current) {
    if (report_resource)
      send_resource(state, [NSString stringWithUTF8String:reason], 0);
    for (size_t index = 0; index < failed_count; index++)
      send_object(state, error_reply(@(failed[index]), @"worker_exited", @"Plugin worker exited"));
    if (!expected)
      send_object(state, @{
        @"event" : @"plugin.crash",
        @"params" : @{
          @"status" : @(status),
          @"reason" : resource ? [NSString stringWithUTF8String:reason] : @"exit"
        }
      });
  }
  free(thread);
  return NULL;
}

static BOOL spawn_worker_locked(BrokerState *state, NSString **message) {
  if (state->worker_pid > 0) return YES;
  NSString *path = fixed_worker_path();
  if (!path) { *message = @"Unable to resolve embedded worker"; return NO; }
  int input[2] = {-1, -1}, output[2] = {-1, -1};
  if (pipe(input) != 0) {
    *message = @"Unable to create worker pipes";
    return NO;
  }
  if (pipe(output) != 0) {
    close(input[0]); close(input[1]);
    *message = @"Unable to create worker pipes";
    return NO;
  }
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, input[0], STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO);
  posix_spawn_file_actions_addclose(&actions, input[1]);
  posix_spawn_file_actions_addclose(&actions, output[0]);
  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  posix_spawnattr_setflags(&attributes,
                           POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT);
  posix_spawnattr_setpgroup(&attributes, 0);
  pid_t pid = 0;
  char *arguments[] = { (char *)path.fileSystemRepresentation, NULL };
  char *environment[] = { NULL };
  int result = posix_spawn(&pid, path.fileSystemRepresentation, &actions,
                           &attributes, arguments, environment);
  posix_spawnattr_destroy(&attributes);
  posix_spawn_file_actions_destroy(&actions);
  close(input[0]);
  close(output[1]);
  if (result != 0) {
    close(input[1]); close(output[0]);
    *message = [NSString stringWithFormat:@"Unable to launch embedded worker: %d", result];
    return NO;
  }
  state->worker_pid = pid;
  state->worker_input = input[1];
  state->generation++;
  state->ready = NO;
  state->startup_deadline_ms = now_ms() + WORKER_STARTUP_LIMIT_MS;
  state->expected_stop = NO;
  state->resource_kill = NO;
  state->command_count = 0;
  WorkerThread *reader = calloc(1, sizeof(WorkerThread));
  *reader = (WorkerThread){ state, pid, output[0], state->generation };
  WorkerThread *watchdog = calloc(1, sizeof(WorkerThread));
  *watchdog = (WorkerThread){ state, pid, -1, state->generation };
  pthread_t reader_thread, watchdog_thread;
  pthread_create(&reader_thread, NULL, read_worker, reader);
  pthread_detach(reader_thread);
  pthread_create(&watchdog_thread, NULL, watch_worker, watchdog);
  pthread_detach(watchdog_thread);
  send_worker_state(state, "workerPid", pid, state->generation);
  return YES;
}

static void handle_resource_kill(BrokerState *state, xpc_object_t event) {
  uint64_t generation = xpc_dictionary_get_uint64(event, "killGeneration");
  uint64_t rss = xpc_dictionary_get_uint64(event, "rssBytes");
  pthread_mutex_lock(&state->lock);
  BOOL current = state->worker_pid > 0 && state->generation == generation;
  if (current) {
    send_resource(state, @"rss", rss);
    kill_worker_locked(state, @"rss");
  }
  pthread_mutex_unlock(&state->lock);
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
  if ([method isEqualToString:@"activate"])
    return [params[@"code"] isKindOfClass:NSString.class] &&
           [params[@"code"] lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 512 * 1024;
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
  *message = @"Unknown plugin method";
  return NO;
}

static void handle_line(BrokerState *state, const void *bytes, size_t length) {
  @autoreleasepool {
    if (length == 0 || length > MAX_LINE_BYTES) {
      send_object(state, error_reply(@0, @"frame_too_large", @"Frame exceeds 1 MiB"));
      return;
    }
    NSData *line = [NSData dataWithBytes:bytes length:length];
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
    NSString *message = nil;
    if (![request isKindOfClass:NSDictionary.class] || !valid_request(request, &message)) {
      NSNumber *identifier = positive_integer(request[@"id"]) ? request[@"id"] : @0;
      send_object(state, error_reply(identifier, @"invalid_request", message ?: @"Malformed JSON"));
      return;
    }
    NSNumber *identifier = request[@"id"];
    NSString *method = request[@"method"];
    pthread_mutex_lock(&state->lock);
    if (state->closing) {
      pthread_mutex_unlock(&state->lock);
      send_object(state, error_reply(identifier, @"closed", @"Plugin broker is closing"));
      return;
    }
    if ([method isEqualToString:@"activate"] && state->worker_pid == 0 &&
        !spawn_worker_locked(state, &message)) {
      pthread_mutex_unlock(&state->lock);
      send_object(state, error_reply(identifier, @"spawn", message));
      return;
    }
    if (state->worker_pid == 0) {
      pthread_mutex_unlock(&state->lock);
      send_object(state, error_reply(identifier, @"not_active", @"Plugin worker is not active"));
      return;
    }
    if (!state->ready &&
        (![method isEqualToString:@"activate"] || state->command_count > 0)) {
      pthread_mutex_unlock(&state->lock);
      send_object(state, error_reply(identifier, @"starting", @"Plugin worker is starting"));
      return;
    }
    if (!add_command_locked(state, identifier.longLongValue)) {
      pthread_mutex_unlock(&state->lock);
      send_object(state, error_reply(identifier, @"capacity", @"Command capacity reached"));
      return;
    }
    if ([method isEqualToString:@"stop"]) state->expected_stop = YES;
    int input = state->worker_input;
    pthread_mutex_unlock(&state->lock);
    BOOL written = write_all(input, bytes, length) && write_all(input, "\n", 1);
    if (!written) {
      pthread_mutex_lock(&state->lock);
      remove_command_locked(state, identifier.longLongValue);
      pthread_mutex_unlock(&state->lock);
      send_object(state, error_reply(identifier, @"write", @"Worker input closed"));
    }
  }
}

static void accept_peer(xpc_connection_t peer) {
  BrokerState *state = calloc(1, sizeof(BrokerState));
  pthread_mutex_init(&state->lock, NULL);
  state->peer = peer;
  state->worker_input = -1;
  dispatch_queue_t queue = dispatch_queue_create(
    "dev.hitchhiker.PluginHost.Broker.peer", DISPATCH_QUEUE_SERIAL);
  xpc_connection_set_target_queue(peer, queue);
  xpc_connection_set_event_handler(peer, ^(xpc_object_t event) {
    xpc_type_t type = xpc_get_type(event);
    if (type == XPC_TYPE_DICTIONARY) {
      if (xpc_dictionary_get_value(event, "killGeneration")) {
        handle_resource_kill(state, event);
      } else {
        size_t length = 0;
        const void *bytes = xpc_dictionary_get_data(event, "line", &length);
        handle_line(state, bytes, length);
      }
    } else if (type == XPC_TYPE_ERROR) {
      pthread_mutex_lock(&state->lock);
      state->closing = YES;
      if (state->worker_pid > 0) kill(-state->worker_pid, SIGKILL);
      pthread_mutex_unlock(&state->lock);
    }
  });
  xpc_connection_resume(peer);
}

int main(void) {
  xpc_main(accept_peer);
}
