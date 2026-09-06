# Hitchhiker plugin host

This macOS-only helper runs one live plugin in one JavaScriptCore process. The
trusted TypeScript runtime launches `PluginHost.app/Contents/MacOS/plugin-host`
with private stdin/stdout pipes and keeps the authoritative plugin identity and
capability grants. The helper accepts no command-line arguments.

The app contains an explicitly App-Sandboxed XPC broker. The broker launches only
its fixed embedded `plugin-worker`, whose signature contains exactly App Sandbox
and sandbox inheritance. The worker receives an empty environment and compiled
JavaScript bytes over a pipe; it never receives a plugin path or identity.

Build on Apple Silicon macOS:

```sh
pnpm --filter @hitchhiker/plugin-host build:native
```

The default is an ad hoc signature and writes the bundle to
`work/plugin-host/build/PluginHost.app`. Set
`HITCHHIKER_CODESIGN_IDENTITY` to an explicit identity for a distribution build.
The build signs the worker, XPC service, and outer app in that order and performs
strict nested verification.

Run the native integration suite:

```sh
pnpm --filter @hitchhiker/plugin-host test:native
```

The runtime package also has a gated end-to-end test. Point it at a production
bundle to include the real host; it is skipped when the variable is absent:

```sh
HITCHHIKER_PLUGIN_HOST="$PWD/work/plugin-host/build/PluginHost.app/Contents/MacOS/plugin-host" \
  pnpm --filter @hitchhiker/runtime test
```

## Host protocol

Each message is one JSON object followed by a newline. Input and output lines are
limited to 1 MiB and the outer app's pending output is limited to 8 MiB. Requests
have a positive safe-integer `id`, a `method`, and object `params`:

```json
{"id":1,"method":"activate","params":{"code":"/* compiled IIFE, at most 512 KiB */"}}
{"id":2,"method":"event","params":{"event":"page.updated","payload":{}}}
{"id":3,"method":"resolve","params":{"callId":1,"result":{}}}
{"id":4,"method":"resolve","params":{"callId":2,"error":{"code":"denied"}}}
{"id":5,"method":"stop","params":{}}
```

A reply contains the same request ID and either `result` or `error`. `plugin.started`
means a fresh worker process is connected. A successful `activate` emits
`plugin.ready` and its reply only after the plugin's returned value or Promise
settles. Activation rejection terminates that worker. Other lifecycle events use
`plugin.resource` and `plugin.crash`.

The compiled IIFE must set `globalThis.HitchhikerPlugin` to an object with
`activate(hitchhiker)` and optional `onEvent(event, payload)` functions. The worker
deletes that global after loading. Its only injected API is a frozen object with:

```js
const result = await hitchhiker.call("pages.list", {});
```

Calls produce an event for the trusted runtime:

```json
{ "event": "plugin.call", "params": { "callId": 1, "method": "pages.list", "params": {} } }
```

The trusted runtime authorizes the method and payload using the identity associated
with this process, then returns `resolve`. Worker-supplied identity is never
accepted. A worker may have at most 32 unresolved calls.

JavaScriptCore receives no Node globals, environment, filesystem, network, timer,
fetch, Objective-C object, raw XPC object, or generic native bridge. A synchronous
command gets 500 ms and the worker gets a 150 MiB physical-footprint limit. The
trusted outer app measures RSS because an App-Sandboxed broker cannot inspect it;
the broker validates a private PID-generation control message and kills the worker
process group. The broker stays alive so a later `activate` starts a fresh worker.

TypeScript/esbuild compilation is outside this package. `activate.code` must
already be a single compiled IIFE. See [the isolation design](../../docs/PLUGIN-ISOLATION.md)
for the verified boundary and remaining release work.
