#import <Foundation/Foundation.h>
#import <JavaScriptCore/JavaScriptCore.h>
#include <arpa/inet.h>
#include <errno.h>
#include <math.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

static const NSUInteger MAX_LINE_BYTES = 1024 * 1024;
static const NSUInteger MAX_CODE_BYTES = 512 * 1024;
static const NSUInteger MAX_CALLS = 32;
static const suseconds_t COMMAND_CPU_LIMIT_US = 500000;
enum { CPU_ACCOUNTING_EXIT = 76 };

typedef struct PendingCall {
  int64_t identifier;
  JSObjectRef resolve;
  JSObjectRef reject;
  struct PendingCall *next;
} PendingCall;

typedef struct {
  JSGlobalContextRef context;
  JSObjectRef api;
  JSObjectRef settle;
  JSObjectRef plugin;
  JSClassRef native_call_class;
  JSClassRef native_complete_class;
  PendingCall *pending;
  NSUInteger pending_count;
  int64_t next_call_id;
  BOOL active;
} WorkerState;

static NSString *exception_message(JSContextRef context, JSValueRef exception);

static BOOL configure_cpu_timer(void) {
  struct sigaction action = {0};
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGPROF, &action, NULL) != 0) return NO;
  sigset_t signals;
  sigemptyset(&signals);
  sigaddset(&signals, SIGPROF);
  return pthread_sigmask(SIG_UNBLOCK, &signals, NULL) == 0;
}

static void set_cpu_timer(BOOL armed) {
  struct itimerval timer = {0};
  if (armed) timer.it_value.tv_usec = COMMAND_CPU_LIMIT_US;
  if (setitimer(ITIMER_PROF, &timer, NULL) != 0) _exit(CPU_ACCOUNTING_EXIT);
}

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

static BOOL emit_object(NSDictionary *object) {
  NSError *error = nil;
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (!encoded || encoded.length + 1 > MAX_LINE_BYTES) return NO;
  return write_all(STDOUT_FILENO, encoded.bytes, encoded.length) &&
         write_all(STDOUT_FILENO, "\n", 1);
}

static NSDictionary *failure(NSNumber *identifier, NSString *code, NSString *message) {
  return @{
    @"id" : identifier ?: @0,
    @"error" : @{ @"code" : code, @"message" : message }
  };
}

static NSString *string_from_js(JSContextRef context, JSValueRef value) {
  JSStringRef string = JSValueToStringCopy(context, value, NULL);
  if (!string) return nil;
  size_t capacity = JSStringGetMaximumUTF8CStringSize(string);
  char *bytes = calloc(capacity, 1);
  JSStringGetUTF8CString(string, bytes, capacity);
  NSString *result = [NSString stringWithUTF8String:bytes];
  free(bytes);
  JSStringRelease(string);
  return result;
}

static JSValueRef js_from_json(JSContextRef context, id value) {
  if (!value || value == NSNull.null) return JSValueMakeNull(context);
  NSData *data = [NSJSONSerialization dataWithJSONObject:value
                                                   options:NSJSONWritingFragmentsAllowed error:nil];
  if (!data) return JSValueMakeUndefined(context);
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  JSStringRef source = JSStringCreateWithCFString((__bridge CFStringRef)json);
  JSValueRef result = JSValueMakeFromJSONString(context, source);
  JSStringRelease(source);
  return result ?: JSValueMakeUndefined(context);
}

static id json_from_js(JSContextRef context, JSValueRef value) {
  JSValueRef exception = NULL;
  JSStringRef json = JSValueCreateJSONString(context, value, 0, &exception);
  if (!json || exception) {
    if (json) JSStringRelease(json);
    return nil;
  }
  size_t capacity = JSStringGetMaximumUTF8CStringSize(json);
  if (capacity > 256 * 1024) {
    JSStringRelease(json);
    return nil;
  }
  char *bytes = calloc(capacity, 1);
  size_t length = JSStringGetUTF8CString(json, bytes, capacity);
  JSStringRelease(json);
  NSData *data = [NSData dataWithBytes:bytes length:length > 0 ? length - 1 : 0];
  free(bytes);
  return [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:nil];
}

static void reject_immediately(WorkerState *state, JSObjectRef reject, NSString *message) {
  JSStringRef text = JSStringCreateWithCFString((__bridge CFStringRef)message);
  JSValueRef argument = JSValueMakeString(state->context, text);
  JSStringRelease(text);
  JSObjectCallAsFunction(state->context, reject, NULL, 1, &argument, NULL);
}

static JSValueRef native_call(JSContextRef context, JSObjectRef function,
                              JSObjectRef this_object, size_t count,
                              const JSValueRef arguments[], JSValueRef *exception) {
  (void)this_object;
  (void)exception;
  WorkerState *state = JSObjectGetPrivate(function);
  if (!state || count != 4 || !JSValueIsString(context, arguments[0]) ||
      !JSValueIsObject(context, arguments[2]) || !JSValueIsObject(context, arguments[3]))
    return JSValueMakeUndefined(context);
  JSObjectRef resolve = JSValueToObject(context, arguments[2], NULL);
  JSObjectRef reject = JSValueToObject(context, arguments[3], NULL);
  NSString *method = string_from_js(context, arguments[0]);
  id params = json_from_js(context, arguments[1]);
  if (!method || method.length == 0 || method.length > 128 ||
      ![params isKindOfClass:NSDictionary.class]) {
    reject_immediately(state, reject, @"Invalid plugin call");
    return JSValueMakeUndefined(context);
  }
  if (state->pending_count >= MAX_CALLS) {
    reject_immediately(state, reject, @"Plugin call capacity reached");
    return JSValueMakeUndefined(context);
  }
  PendingCall *pending = calloc(1, sizeof(PendingCall));
  pending->identifier = ++state->next_call_id;
  pending->resolve = resolve;
  pending->reject = reject;
  pending->next = state->pending;
  state->pending = pending;
  state->pending_count++;
  JSValueProtect(context, resolve);
  JSValueProtect(context, reject);
  if (!emit_object(@{
        @"event" : @"plugin.call",
        @"params" : @{ @"callId" : @(pending->identifier), @"method" : method, @"params" : params }
      })) {
    _exit(74);
  }
  return JSValueMakeUndefined(context);
}

static JSValueRef native_complete(JSContextRef context, JSObjectRef function,
                                  JSObjectRef this_object, size_t count,
                                  const JSValueRef arguments[], JSValueRef *exception) {
  (void)this_object;
  (void)exception;
  WorkerState *state = JSObjectGetPrivate(function);
  if (!state || count != 3 || !JSValueIsNumber(context, arguments[0]) ||
      !JSValueIsBoolean(context, arguments[1]))
    return JSValueMakeUndefined(context);
  double raw_identifier = JSValueToNumber(context, arguments[0], NULL);
  if (!isfinite(raw_identifier) || raw_identifier < 1 ||
      raw_identifier > 9007199254740991.0 || floor(raw_identifier) != raw_identifier)
    return JSValueMakeUndefined(context);
  NSNumber *identifier = @((int64_t)raw_identifier);
  BOOL activation = JSValueToBoolean(context, arguments[1]);
  BOOL rejected = !JSValueIsNull(context, arguments[2]) &&
                  !JSValueIsUndefined(context, arguments[2]);
  if (rejected) {
    emit_object(failure(identifier, @"javascript", exception_message(context, arguments[2])));
    if (activation) _exit(65);
  } else {
    if (activation) {
      state->active = YES;
      emit_object(@{ @"event" : @"plugin.ready", @"params" : @{} });
    }
    emit_object(@{ @"id" : identifier, @"result" : NSNull.null });
  }
  return JSValueMakeUndefined(context);
}

static NSString *exception_message(JSContextRef context, JSValueRef exception) {
  NSString *message = exception ? string_from_js(context, exception) : nil;
  return message.length > 0 ? message : @"JavaScript execution failed";
}

static BOOL call_plugin_async(WorkerState *state, NSString *name, NSArray *arguments,
                              NSNumber *identifier, BOOL activation, NSString **message) {
  JSStringRef key = JSStringCreateWithCFString((__bridge CFStringRef)name);
  JSValueRef value = JSObjectGetProperty(state->context, state->plugin, key, NULL);
  JSStringRelease(key);
  if (JSValueIsUndefined(state->context, value) && [name isEqualToString:@"onEvent"]) {
    emit_object(@{ @"id" : identifier, @"result" : NSNull.null });
    return YES;
  }
  if (!JSValueIsObject(state->context, value) ||
      !JSObjectIsFunction(state->context, JSValueToObject(state->context, value, NULL))) {
    *message = [NSString stringWithFormat:@"HitchhikerPlugin.%@ must be a function", name];
    return NO;
  }
  JSObjectRef function = JSValueToObject(state->context, value, NULL);
  JSValueRef values[2] = {0};
  NSUInteger argument_count = activation ? 1 : arguments.count;
  if (activation) values[0] = state->api;
  else for (NSUInteger index = 0; index < arguments.count; index++)
    values[index] = js_from_json(state->context, arguments[index]);
  JSValueRef exception = NULL;
  JSValueRef result = JSObjectCallAsFunction(state->context, function, state->plugin,
                                             argument_count, values, &exception);
  if (exception) {
    *message = exception_message(state->context, exception);
    return NO;
  }
  JSValueRef settle_arguments[] = {
    result,
    JSValueMakeNumber(state->context, identifier.doubleValue),
    JSValueMakeBoolean(state->context, activation),
  };
  JSObjectCallAsFunction(state->context, state->settle, NULL, 3, settle_arguments, &exception);
  if (exception) {
    *message = exception_message(state->context, exception);
    return NO;
  }
  emit_object(@{ @"control" : @"command.wait", @"id" : identifier });
  return YES;
}

static BOOL activate(WorkerState *state, NSString *code, NSString **message) {
  if (state->plugin) { *message = @"Plugin is already active"; return NO; }
  if ([code lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > MAX_CODE_BYTES) {
    *message = @"Plugin code exceeds 512 KiB";
    return NO;
  }
  JSStringRef source = JSStringCreateWithCFString((__bridge CFStringRef)code);
  JSStringRef url = JSStringCreateWithUTF8CString("hitchhiker-plugin.js");
  JSValueRef exception = NULL;
  JSEvaluateScript(state->context, source, NULL, url, 1, &exception);
  JSStringRelease(source);
  JSStringRelease(url);
  if (exception) { *message = exception_message(state->context, exception); return NO; }
  JSObjectRef global = JSContextGetGlobalObject(state->context);
  JSStringRef plugin_key = JSStringCreateWithUTF8CString("HitchhikerPlugin");
  JSValueRef plugin_value = JSObjectGetProperty(state->context, global, plugin_key, NULL);
  JSObjectDeleteProperty(state->context, global, plugin_key, NULL);
  JSStringRelease(plugin_key);
  if (!JSValueIsObject(state->context, plugin_value)) {
    *message = @"Bundle must set globalThis.HitchhikerPlugin";
    return NO;
  }
  state->plugin = JSValueToObject(state->context, plugin_value, NULL);
  JSValueProtect(state->context, state->plugin);
  return YES;
}

static void handle_resolve(WorkerState *state, NSDictionary *params, NSNumber *identifier) {
  NSNumber *call_id = params[@"callId"];
  if (!positive_integer(call_id)) {
    emit_object(failure(identifier, @"invalid_request", @"callId must be a positive integer"));
    return;
  }
  PendingCall **cursor = &state->pending;
  while (*cursor && (*cursor)->identifier != call_id.longLongValue) cursor = &(*cursor)->next;
  if (!*cursor) {
    emit_object(failure(identifier, @"unknown_call", @"Unknown plugin call"));
    return;
  }
  PendingCall *pending = *cursor;
  *cursor = pending->next;
  state->pending_count--;
  BOOL rejected = params[@"error"] != nil;
  JSValueRef argument = js_from_json(state->context,
    rejected ? params[@"error"] : (params[@"result"] ?: NSNull.null));
  JSValueRef exception = NULL;
  JSObjectCallAsFunction(state->context, rejected ? pending->reject : pending->resolve,
                         NULL, 1, &argument, &exception);
  JSValueUnprotect(state->context, pending->resolve);
  JSValueUnprotect(state->context, pending->reject);
  free(pending);
  if (exception)
    emit_object(failure(identifier, @"javascript", exception_message(state->context, exception)));
  else
    emit_object(@{ @"id" : identifier, @"result" : NSNull.null });
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

#if PLUGIN_HOST_TESTING
static void emit_isolation_probe(void) {
  errno = 0;
  FILE *file = fopen("/tmp/hitchhiker-plugin-host-deny-fixture", "r");
  int open_error = file ? 0 : errno;
  if (file) fclose(file);
  int descriptor = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(38991) };
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
  errno = 0;
  int connected = descriptor >= 0
    ? connect(descriptor, (struct sockaddr *)&address, sizeof(address)) : -1;
  int connect_error = connected == 0 ? 0 : errno;
  if (descriptor >= 0) close(descriptor);
  emit_object(@{
    @"event" : @"plugin.testIsolation",
    @"params" : @{ @"openErrno" : @(open_error), @"connectErrno" : @(connect_error) }
  });
}
#endif

int main(void) {
  @autoreleasepool {
#if PLUGIN_HOST_TEST_STARTUP_DELAY
    usleep(650000);
#endif
#if PLUGIN_HOST_TEST_STARTUP_HANG
    for (;;) pause();
#endif
    WorkerState state = {0};
    state.context = JSGlobalContextCreate(NULL);
    JSClassDefinition definition = kJSClassDefinitionEmpty;
    definition.callAsFunction = native_call;
    state.native_call_class = JSClassCreate(&definition);
    JSObjectRef native = JSObjectMake(state.context, state.native_call_class, &state);
    JSClassDefinition complete_definition = kJSClassDefinitionEmpty;
    complete_definition.callAsFunction = native_complete;
    state.native_complete_class = JSClassCreate(&complete_definition);
    JSObjectRef complete = JSObjectMake(state.context, state.native_complete_class, &state);
    JSObjectRef global = JSContextGetGlobalObject(state.context);
    JSStringRef native_key = JSStringCreateWithUTF8CString("__hitchhikerNativeCall");
    JSObjectSetProperty(state.context, global, native_key, native, kJSPropertyAttributeDontEnum, NULL);
    JSStringRelease(native_key);
    JSStringRef complete_key = JSStringCreateWithUTF8CString("__hitchhikerNativeComplete");
    JSObjectSetProperty(state.context, global, complete_key, complete,
                        kJSPropertyAttributeDontEnum, NULL);
    JSStringRelease(complete_key);
    JSStringRef wrapper_source = JSStringCreateWithUTF8CString(
      "(() => { const invoke = globalThis.__hitchhikerNativeCall; "
      "const complete = globalThis.__hitchhikerNativeComplete; "
      "const NativePromise = Promise; const NativeString = String; "
      "const resolvePromise = Promise.resolve.bind(Promise); "
      "const thenPromise = Function.call.bind(Promise.prototype.then); "
      "delete globalThis.__hitchhikerNativeCall; delete globalThis.__hitchhikerNativeComplete; "
      "const call = (method, params = {}) => new NativePromise((resolve, reject) => "
      "invoke(method, params, resolve, reject)); Object.freeze(call); "
      "const settle = (value, id, activation) => thenPromise(resolvePromise(value), "
      "() => complete(id, activation, null), "
      "error => complete(id, activation, NativeString(error))); Object.freeze(settle); "
      "return Object.freeze({api: Object.freeze({call}), settle}); })()");
    JSValueRef wrapper_error = NULL;
    JSValueRef api_value = JSEvaluateScript(state.context, wrapper_source, NULL, NULL, 1, &wrapper_error);
    JSStringRelease(wrapper_source);
    if (wrapper_error || !JSValueIsObject(state.context, api_value)) return 70;
    JSObjectRef wrapper = JSValueToObject(state.context, api_value, NULL);
    JSStringRef api_key = JSStringCreateWithUTF8CString("api");
    JSStringRef settle_key = JSStringCreateWithUTF8CString("settle");
    state.api = JSValueToObject(state.context,
      JSObjectGetProperty(state.context, wrapper, api_key, NULL), NULL);
    state.settle = JSValueToObject(state.context,
      JSObjectGetProperty(state.context, wrapper, settle_key, NULL), NULL);
    JSStringRelease(api_key);
    JSStringRelease(settle_key);
    if (!state.api || !state.settle) return 70;
    JSValueProtect(state.context, state.api);
    JSValueProtect(state.context, state.settle);
    if (!configure_cpu_timer()) return CPU_ACCOUNTING_EXIT;
    emit_object(@{ @"event" : @"plugin.started", @"params" : @{} });
#if PLUGIN_HOST_TESTING
    emit_isolation_probe();
#endif

    for (;;) {
      @autoreleasepool {
        BOOL eof = NO, oversized = NO;
        NSData *line = read_line(&eof, &oversized);
        if (!line && eof) break;
        if (!line) continue;
        if (oversized) { emit_object(failure(@0, @"frame_too_large", @"Frame exceeds 1 MiB")); continue; }
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
        NSNumber *identifier = [request isKindOfClass:NSDictionary.class] ? request[@"id"] : @0;
        NSString *method = [request isKindOfClass:NSDictionary.class] ? request[@"method"] : nil;
        NSDictionary *params = [request isKindOfClass:NSDictionary.class] ? request[@"params"] : nil;
        if (!positive_integer(identifier) ||
            ![method isKindOfClass:NSString.class] || ![params isKindOfClass:NSDictionary.class]) {
          emit_object(failure(@0, @"invalid_request", @"Invalid request"));
          continue;
        }
        BOOL cpu_timed =
          ([method isEqualToString:@"activate"] && [params[@"code"] isKindOfClass:NSString.class]) ||
          ([method isEqualToString:@"event"] && state.active &&
           [params[@"event"] isKindOfClass:NSString.class] && params[@"payload"] != nil) ||
          ([method isEqualToString:@"resolve"] && positive_integer(params[@"callId"]));
        if (cpu_timed) set_cpu_timer(YES);
        if ([method isEqualToString:@"activate"] && [params[@"code"] isKindOfClass:NSString.class]) {
          NSString *message = nil;
          if (!activate(&state, params[@"code"], &message) ||
              !call_plugin_async(&state, @"activate", @[], identifier, YES, &message)) {
            emit_object(failure(identifier, @"javascript", message));
            _exit(65);
          }
        } else if ([method isEqualToString:@"event"] && state.active &&
                   [params[@"event"] isKindOfClass:NSString.class] && params[@"payload"] != nil) {
          NSString *message = nil;
          if (!call_plugin_async(&state, @"onEvent",
                                 @[ params[@"event"], params[@"payload"] ],
                                 identifier, NO, &message))
            emit_object(failure(identifier, @"javascript", message));
        } else if ([method isEqualToString:@"resolve"] &&
                   positive_integer(params[@"callId"])) {
          handle_resolve(&state, params, identifier);
        } else if ([method isEqualToString:@"stop"]) {
          emit_object(@{ @"id" : identifier, @"result" : NSNull.null });
          break;
        } else {
          emit_object(failure(identifier, @"invalid_request", @"Invalid method or parameters"));
        }
        if (cpu_timed) set_cpu_timer(NO);
      }
    }
    while (state.pending) {
      PendingCall *next = state.pending->next;
      JSValueUnprotect(state.context, state.pending->resolve);
      JSValueUnprotect(state.context, state.pending->reject);
      free(state.pending);
      state.pending = next;
    }
    if (state.plugin) JSValueUnprotect(state.context, state.plugin);
    JSValueUnprotect(state.context, state.api);
    JSValueUnprotect(state.context, state.settle);
    JSClassRelease(state.native_call_class);
    JSClassRelease(state.native_complete_class);
    JSGlobalContextRelease(state.context);
  }
  return 0;
}
