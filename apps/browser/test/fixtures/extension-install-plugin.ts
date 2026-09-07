import { definePlugin, type PluginApi } from "@hitchhiker/plugin-sdk";

let api: PluginApi;
let operationId: string | undefined;
let reviewRequested = false;
let tail: Promise<void> = Promise.resolve();
let lastState = "";
const enqueue = (action: () => Promise<void>) => {
  const result = tail.then(action);
  tail = result.catch(() => undefined);
  return result;
};
const refresh = async () => {
  if (!operationId) return;
  let snapshot = await api.extensions.installation.status(operationId);
  if (snapshot.state === "awaiting_review" && !reviewRequested) {
    reviewRequested = true;
    snapshot = await api.extensions.installation.requestReview(operationId);
  }
  const next = JSON.stringify(snapshot);
  if (lastState === next) return;
  const storage = await api.storage.read();
  await api.storage.write(storage.revision, {
    phase: snapshot.state,
    operationId,
    installationId: snapshot.extension?.installationId ?? null,
  });
  lastState = next;
};
const ascii = (source: string) => Uint8Array.from(source, (character) => character.charCodeAt(0));

definePlugin({
  async activate(host) {
    api = host;
    const manifest = JSON.stringify({
      manifest_version: 3,
      name: "Public installation fixture",
      version: "1.0",
      host_permissions: ["http://127.0.0.1/*"],
      content_scripts: [
        { matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_start" },
      ],
      web_accessible_resources: [{ resources: ["resource.bin"], matches: ["http://127.0.0.1/*"] }],
    });
    const content = `fetch(chrome.runtime.getURL('resource.bin')).then(r=>r.arrayBuffer()).then(b=>{
const a=[...new Uint8Array(b)],e=[0,1,127,128,255,42];
if(a.length===e.length&&a.every((v,i)=>v===e[i])){
const mark=()=>document.documentElement.setAttribute('data-public-installation','enabled');
if(document.documentElement)mark();else addEventListener('DOMContentLoaded',mark,{once:true});
}});`;
    const begun = await api.extensions.installation.begin();
    operationId = begun.operationId;
    for (const [path, bytes] of [
      ["manifest.json", ascii(manifest)],
      ["content.js", ascii(content)],
      ["resource.bin", new Uint8Array([0, 1, 127, 128, 255, 42])],
    ] as const) {
      await api.extensions.installation.beginFile(operationId, path, bytes.byteLength);
      await api.extensions.installation.append(operationId, 0, bytes);
    }
    await api.extensions.installation.finish(operationId);
    await enqueue(refresh);
  },
  onEvent(event) {
    if (event === "extensions.installation.changed") return enqueue(refresh);
  },
});
