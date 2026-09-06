// Chrome match patterns are not a substitute for an exact fixture-origin guard.
if (location.origin === "http://127.0.0.1:4319" && ["/one", "/two"].includes(location.pathname)) {
  const status = document.querySelector("#fixture-extension-status");
  chrome.runtime.sendMessage({ type: "host-probe" }, (response) => {
    if (!(status instanceof HTMLElement)) return;
    if (chrome.runtime.lastError) {
      status.textContent = `Extension status: ${chrome.runtime.lastError.message}`;
      return;
    }
    if (
      !Number.isInteger(response?.count) ||
      !Number.isInteger(response?.tabId) ||
      !Number.isInteger(response?.windowId)
    ) {
      status.textContent = "Extension status: invalid worker response";
      return;
    }
    status.textContent = `Extension status: worker count ${response.count}; tab ${response.tabId}; window ${response.windowId}`;
    status.dataset.probeCount = String(response.count);
  });
}
