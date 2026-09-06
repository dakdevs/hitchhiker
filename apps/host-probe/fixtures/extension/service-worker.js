let pending = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "host-probe" || sender.id !== chrome.runtime.id) return;
  let url;
  try {
    url = new URL(sender.url);
  } catch {
    return;
  }
  if (url.origin !== "http://127.0.0.1:4319" || !["/one", "/two"].includes(url.pathname)) return;
  // Serialize read/update pairs when both fixtures ask the worker at once.
  pending = pending
    .then(async () => {
      const { probeMessages } = await chrome.storage.local.get({ probeMessages: 0 });
      const next = probeMessages + 1;
      await chrome.storage.local.set({ probeMessages: next });
      sendResponse({
        count: next,
        tabId: sender.tab?.id ?? null,
        windowId: sender.tab?.windowId ?? null,
      });
    })
    .catch(() => sendResponse({ error: "Probe storage failed" }));
  return true;
});
