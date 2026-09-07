# Composition example

This workspace builds three independent UI plugin artifacts: `split-layout` publishes the window
layout and its `content` slot; `split-left` and `split-right` each publish a `page` contribution.
The host namespaces those matching contribution names by the identities in the active plan.

Build the artifacts after repository dependencies are available:

```sh
pnpm --filter @hitchhiker/composition-example build
```

Use the public MCP plan flow. In one authenticated MCP connection, call
`hitchhiker_plugin_stage` once for each manifest and matching `dist/*.js` artifact. Staging delegates
only the manifest's requested capabilities and leaves every identity disabled. Then read the current
revision and promote the whole cohort atomically:

```json
{ "name": "hitchhiker_plugin_plan", "arguments": {} }
```

Use its returned `result.revision` as `expectedRevision` here:

```json
{
  "name": "hitchhiker_plugin_apply_plan",
  "arguments": {
    "expectedRevision": 0,
    "candidate": {
      "enabled": ["split-layout", "split-left", "split-right"],
      "composition": {
        "layout": "split-layout",
        "slots": [
          {
            "key": "content",
            "contributions": [
              { "pluginId": "split-left", "id": "page" },
              { "pluginId": "split-right", "id": "page" }
            ]
          }
        ]
      },
      "serviceBindings": []
    }
  }
}
```

Every later UI change is another complete `hitchhiker_plugin_apply_plan` candidate with the latest
revision. To remove `split-left`, first apply a candidate that omits it from both `enabled` and the
composition contribution list; only then call `hitchhiker_plugin_uninstall`. To add it back, stage
the artifact again and apply the full three-plugin candidate above. Do not copy `composition.json`
into the profile: it is a readable example of the candidate recipe, while Version 2 profiles restore
their persisted active plan and ignore legacy recipe files.

Composition has a four-worker limit. `--safe-mode` does not launch plugins. A missing or incomplete
composition remains repairable through the trusted recovery surface.

## Services without a UI layout

The build also emits `service-provider.js` and `service-consumer.js`. Stage both manifests, then
apply this headless candidate using the revision returned by `hitchhiker_plugin_plan`:

```json
{
  "enabled": ["service-provider", "service-consumer"],
  "serviceBindings": [
    {
      "consumer": "service-consumer",
      "dependency": "counter",
      "provider": "service-provider",
      "service": "counter"
    }
  ]
}
```

Neither service requests page authority. The manager validates declarations, exact contract identities
and durable grants before promotion. When changing providers or dependencies, submit the complete
replacement plan rather than a legacy `services.json` file.

See [the installed native fixture](../../packages/runtime/test/native-installed-composition.test.ts)
for executable UI-plan installation, removal and restart coverage, and the
[SDK reference](../../packages/plugin-sdk/README.md#plugin-services) for service authority and limits.
