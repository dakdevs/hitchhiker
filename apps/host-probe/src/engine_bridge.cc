// Copyright (c) 2026 Hitchhiker contributors.
// SPDX-License-Identifier: BSD-3-Clause

#include "src/engine_bridge.h"

#include <atomic>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include "include/base/cef_callback.h"
#include "include/cef_browser.h"
#include "include/cef_devtools_message_observer.h"
#include "include/cef_parser.h"
#include "include/cef_registration.h"
#include "include/cef_task.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"
#include "src/page_manager.h"

namespace {

constexpr size_t kMaxFrameBytes = 256 * 1024;
constexpr size_t kMaxPendingRequests = 64;
constexpr size_t kMaxPendingCdp = 64;
constexpr size_t kMaxOutputFrameBytes = 8 * 1024 * 1024;
constexpr size_t kMaxOutputBytes = 16 * 1024 * 1024;
constexpr size_t kMaxPages = 128;
constexpr size_t kMaxViewports = 32;
constexpr int kIoPollMs = 100;
constexpr int kCdpTimeoutMs = 15 * 1000;
constexpr int kMaxCoordinate = 1000000;
// Root teardown must not discard the session-close event that it just queued.
// Keep this finite: a parent that has stopped reading stdout must not freeze
// CEF's UI thread while Stop joins the writer.
constexpr int kShutdownOutputDrainMs = 500;

void Diagnose(const char* message) {
  std::fprintf(stderr, "HITCHHIKER_HOST_IPC %s\n", message);
}

CefRefPtr<CefValue> NewValue(CefRefPtr<CefDictionaryValue> dictionary) {
  CefRefPtr<CefValue> value = CefValue::Create();
  value->SetDictionary(dictionary);
  return value;
}

CefRefPtr<CefValue> NewValue(CefRefPtr<CefListValue> list) {
  CefRefPtr<CefValue> value = CefValue::Create();
  value->SetList(list);
  return value;
}

bool IsPageId(const std::string& id) {
  if (id.empty() || id.size() > 64 || !std::isalpha(static_cast<unsigned char>(id[0]))) {
    return false;
  }
  for (char ch : id) {
    if (!std::isalnum(static_cast<unsigned char>(ch)) && ch != '_' && ch != '-') return false;
  }
  return true;
}

bool IsAllowedUrl(const std::string& url) {
  CefURLParts parts;
  if (!CefParseURL(url, parts)) return false;
  const std::string scheme = CefString(&parts.scheme).ToString();
  return (scheme == "http" || scheme == "https") || url == "about:blank";
}

bool GetPositiveId(CefRefPtr<CefDictionaryValue> value, int* id) {
  if (!value || value->GetType("id") != VTYPE_INT) return false;
  *id = value->GetInt("id");
  return *id > 0;
}

bool GetString(CefRefPtr<CefDictionaryValue> value,
               const char* key,
               std::string* out) {
  if (!value || value->GetType(key) != VTYPE_STRING) return false;
  *out = value->GetString(key).ToString();
  return true;
}

bool GetInt(CefRefPtr<CefDictionaryValue> value, const char* key, int* out) {
  if (!value || value->GetType(key) != VTYPE_INT) return false;
  *out = value->GetInt(key);
  return true;
}

void SetGeneration(CefRefPtr<CefDictionaryValue> value, uint32_t generation) {
  // CEF's integer value is signed. A double represents every uint32 exactly.
  value->SetDouble("generation", static_cast<double>(generation));
}

class BridgeTask : public CefTask {
 public:
  explicit BridgeTask(std::function<void()> work) : work_(std::move(work)) {}
  void Execute() override { work_(); }
 private:
  std::function<void()> work_;
  IMPLEMENT_REFCOUNTING(BridgeTask);
};

}  // namespace

class EngineBridge::Core : public std::enable_shared_from_this<EngineBridge::Core> {
 public:
  Core(CefRefPtr<PageManager> manager, CefRefPtr<CefWindow> root)
      : manager_(manager), root_(root) {}
  ~Core() { Stop(); }

  void Start() {
    CEF_REQUIRE_UI_THREAD();
    if (started_ || stopped_) return;
    started_ = true;
    reader_ = std::thread([self = shared_from_this()] { self->ReadLoop(); });
    writer_ = std::thread([self = shared_from_this()] { self->WriteLoop(); });
    CefRefPtr<CefDictionaryValue> ready = CefDictionaryValue::Create();
    ready->SetInt("version", 1);
    // Runtime schedulers must treat a missing/false capability as protected.
    ready->SetBool("pageResourceSignals", true);
    ready->SetBool("pageBrowserGeneration", true);
    if (root_) {
      const CefRect bounds = root_->GetClientAreaBoundsInScreen();
      CefRefPtr<CefDictionaryValue> client = CefDictionaryValue::Create();
      client->SetInt("x", bounds.x);
      client->SetInt("y", bounds.y);
      client->SetInt("width", bounds.width);
      client->SetInt("height", bounds.height);
      ready->SetDictionary("windowClientBounds", client);
    }
    SendEvent("host.ready", ready);
  }

  void Stop() {
    // Stop may be called from the CEF UI thread or during final ref release.
    const bool was_stopped = stopped_.exchange(true);
    if (!was_stopped) {
      {
        std::lock_guard<std::mutex> lock(output_lock_);
        output_drain_deadline_ = std::chrono::steady_clock::now() +
                                 std::chrono::milliseconds(kShutdownOutputDrainMs);
      }
      output_cv_.notify_all();
    }
    if (reader_.joinable()) reader_.join();
    if (writer_.joinable()) writer_.join();
    if (CefCurrentlyOn(TID_UI)) {
      registrations_.clear();
      observers_.clear();
      observer_generations_.clear();
      pending_cdp_.clear();
      manager_ = nullptr;
      root_ = nullptr;
      page_ids_.clear();
    }
  }

  void OnPageEvent(const PageEvent& event) {
    CEF_REQUIRE_UI_THREAD();
    if (stopped_) return;
    CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
    if (!event.page_id.empty()) {
      params->SetString("pageId", event.page_id);
      SetGeneration(params, event.generation);
    }
    switch (event.type) {
      case PageEvent::kCreated:
        page_ids_.insert(event.page_id);
        SendEvent("pages.created", params);
        break;
      case PageEvent::kBrowserUnavailable:
        RetireGeneration(event.page_id, event.generation,
                         "browser unavailable before DevTools response");
        SendEvent("pages.browserUnavailable", params);
        break;
      case PageEvent::kReplaced:
        RetireGeneration(event.page_id, event.previous_generation,
                         "browser replaced before DevTools response");
        params->SetDouble("previousGeneration",
                          static_cast<double>(event.previous_generation));
        SendEvent("pages.replaced", params);
        break;
      case PageEvent::kDocumentCommitted:
        SendEvent("pages.documentCommitted", params);
        break;
      case PageEvent::kClosed:
        page_ids_.erase(event.page_id);
        for (auto it = pending_cdp_.begin(); it != pending_cdp_.end();) {
          if (it->second.page_id == event.page_id) {
            ReplyError(it->second.request_id, -32001, "page closed before DevTools response");
            it = pending_cdp_.erase(it);
          } else {
            ++it;
          }
        }
        registrations_.erase(event.page_id);
        observers_.erase(event.page_id);
        observer_generations_.erase(event.page_id);
        params->SetInt("remainingPages", static_cast<int>(event.remaining_pages));
        params->SetString(
            "reason",
            event.close_reason == PageEvent::CloseReason::kWindowClose
                ? "window-close"
                : "page-close");
        SendEvent("pages.closed", params);
        break;
      case PageEvent::kCloseCancelled:
        SendEvent("pages.closeCancelled", params);
        break;
      case PageEvent::kWindowClosing:
        SendEvent("window.closing", params);
        break;
      case PageEvent::kWindowCloseCancelled:
        SendEvent("window.closeCancelled", params);
        break;
      case PageEvent::kTitleChanged:
        params->SetString("title", event.title.ToString().substr(0, 4096));
        SendEvent("pages.titleChanged", params);
        break;
      case PageEvent::kNavigationChanged:
        if (const auto snapshot = manager_->SnapshotForPage(event.page_id)) {
          params->SetString("url", snapshot->url);
          params->SetBool("loading", snapshot->loading);
          params->SetBool("canGoBack", snapshot->can_go_back);
          params->SetBool("canGoForward", snapshot->can_go_forward);
          SendEvent("pages.navigationChanged", params);
        }
        break;
      case PageEvent::kResourcesChanged:
        params->SetBool("known", event.resources_known);
        params->SetBool("audio", event.audio);
        params->SetBool("call", event.call);
        params->SetBool("download", event.download);
        params->SetBool("unsavedInput", event.unsaved_input);
        SendEvent("pages.resourcesChanged", params);
        break;
    }
  }

  void SendEvent(const std::string& name, CefRefPtr<CefDictionaryValue> params) {
    CEF_REQUIRE_UI_THREAD();
    if (stopped_ || !params) return;
    CefRefPtr<CefDictionaryValue> message = CefDictionaryValue::Create();
    message->SetString("event", name);
    message->SetDictionary("params", params->Copy(false));
    EnqueueJson(WriteJson(message));
  }

  void SetUiCommitHandler(EngineBridge::UiCommitHandler handler) {
    CEF_REQUIRE_UI_THREAD();
    ui_commit_handler_ = std::move(handler);
  }

  void SetCloseRequestHandler(EngineBridge::CloseRequestHandler handler) {
    CEF_REQUIRE_UI_THREAD();
    close_request_handler_ = std::move(handler);
  }
  void SetWindowChromeHandler(EngineBridge::WindowChromeHandler handler) {
    CEF_REQUIRE_UI_THREAD();
    window_chrome_handler_ = std::move(handler);
  }

  void ProcessInput(std::string input) {
    CEF_REQUIRE_UI_THREAD();
    if (stopped_) return;
    CefRefPtr<CefValue> parsed = CefParseJSON(input, JSON_PARSER_RFC);
    CefRefPtr<CefDictionaryValue> request =
        parsed && parsed->GetType() == VTYPE_DICTIONARY ? parsed->GetDictionary() : nullptr;
    int request_id = 0;
    if (!GetPositiveId(request, &request_id)) {
      Diagnose("invalid request id");
      return;  // Cannot produce a protocol response without a positive ID.
    }
    std::string method;
    CefRefPtr<CefDictionaryValue> params;
    if (!GetString(request, "method", &method) ||
        request->GetType("params") != VTYPE_DICTIONARY) {
      ReplyError(request_id, -32600, "request requires method and object params");
      return;
    }
    params = request->GetDictionary("params");
    HandleRequest(request_id, method, params);
  }

  void RequestClose() {
    CEF_REQUIRE_UI_THREAD();
    if (stopped_) return;
    if (close_request_handler_) {
      close_request_handler_();
      return;
    }
    // The standalone bridge fallback has no shell coordinator. Production
    // wiring always installs the handler above.
    if (root_ && !root_->IsClosed()) root_->Close();
  }

  void OnDevToolsResult(const std::string& page_id,
                        uint32_t generation,
                        CefRefPtr<CefBrowser> browser,
                        int cdp_id,
                        bool success,
                        const void* result,
                        size_t result_size) {
    CEF_REQUIRE_UI_THREAD();
    auto it = pending_cdp_.find(cdp_id);
    if (stopped_ || it == pending_cdp_.end() || it->second.page_id != page_id ||
        it->second.generation != generation ||
        !IsCurrentPageBrowser(page_id, generation, browser)) return;
    const int request_id = it->second.request_id;
    pending_cdp_.erase(it);
    if (result_size > 4 * 1024 * 1024) {
      ReplyError(request_id, -32000, "DevTools response exceeds private host limit");
      return;
    }
    CefRefPtr<CefValue> value = result_size == 0
                                    ? NewValue(CefDictionaryValue::Create())
                                    : CefParseJSON(result, result_size, JSON_PARSER_RFC);
    if (!value) {
      ReplyError(request_id, -32000, "invalid DevTools response");
    } else if (success) {
      ReplyResult(request_id, value);
    } else {
      CefRefPtr<CefDictionaryValue> error =
          value->GetType() == VTYPE_DICTIONARY ? value->GetDictionary() : nullptr;
      ReplyError(request_id, error && error->GetType("code") == VTYPE_INT ? error->GetInt("code") : -32000,
                 error && error->GetType("message") == VTYPE_STRING
                     ? error->GetString("message").ToString() : "DevTools method failed");
    }
  }

  void OnDevToolsEvent(const std::string& page_id,
                       uint32_t generation,
                       CefRefPtr<CefBrowser> browser,
                       const CefString& method,
                       const void* params,
                       size_t params_size) {
    CEF_REQUIRE_UI_THREAD();
    if (stopped_ || !IsCurrentPageBrowser(page_id, generation, browser)) return;
    if (params_size > 4 * 1024 * 1024) return;
    CefRefPtr<CefDictionaryValue> event = CefDictionaryValue::Create();
    event->SetString("pageId", page_id);
    SetGeneration(event, generation);
    event->SetString("method", method);
    CefRefPtr<CefValue> parsed = CefParseJSON(params, params_size, JSON_PARSER_RFC);
    if (parsed) event->SetValue("params", parsed);
    else event->SetDictionary("params", CefDictionaryValue::Create());
    SendEvent("cdp.event", event);
  }

 private:
  class Observer : public CefDevToolsMessageObserver {
   public:
    Observer(std::weak_ptr<Core> core, std::string page_id, uint32_t generation)
        : core_(std::move(core)), page_id_(std::move(page_id)), generation_(generation) {}
    void OnDevToolsMethodResult(CefRefPtr<CefBrowser> browser, int id, bool success,
                                const void* result, size_t size) override {
      if (auto core = core_.lock()) core->OnDevToolsResult(page_id_, generation_, browser, id, success, result, size);
    }
    void OnDevToolsEvent(CefRefPtr<CefBrowser> browser, const CefString& method,
                         const void* params, size_t size) override {
      if (auto core = core_.lock()) core->OnDevToolsEvent(page_id_, generation_, browser, method, params, size);
    }
   private:
    std::weak_ptr<Core> core_;
    std::string page_id_;
    uint32_t generation_;
    IMPLEMENT_REFCOUNTING(Observer);
  };

  struct PendingCdp { int request_id; std::string page_id; uint32_t generation; };

  static std::atomic<int> next_cdp_id_;

  void ReadLoop() {
    std::string pending;
    char buffer[8192];
    while (!stopped_ && !output_failed_) {
      pollfd descriptor{STDIN_FILENO, POLLIN | POLLHUP, 0};
      const int poll_result = poll(&descriptor, 1, kIoPollMs);
      if (poll_result <= 0) continue;
      const ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
      if (count <= 0) {
        if (count == 0) PostClose();
        else if (errno != EINTR && errno != EAGAIN) Diagnose("stdin read failed");
        break;
      }
      pending.append(buffer, static_cast<size_t>(count));
      size_t newline = 0;
      while ((newline = pending.find('\n')) != std::string::npos) {
        std::string frame = pending.substr(0, newline);
        pending.erase(0, newline + 1);
        if (!frame.empty() && frame.back() == '\r') frame.pop_back();
        if (frame.size() > kMaxFrameBytes) {
          Diagnose("stdin frame exceeds limit");
          PostClose();
          return;
        }
        PostInput(std::move(frame));
      }
      // Only the incomplete tail is subject to this limit. Complete adjacent
      // frames can legitimately exceed it in one read.
      if (pending.size() > kMaxFrameBytes) {
        Diagnose("stdin frame exceeds limit");
        PostClose();
        return;
      }
    }
  }

  void WriteLoop() {
    sigset_t blocked_signals;
    sigemptyset(&blocked_signals);
    sigaddset(&blocked_signals, SIGPIPE);
    pthread_sigmask(SIG_BLOCK, &blocked_signals, nullptr);
    const int previous_flags = fcntl(STDOUT_FILENO, F_GETFL, 0);
    if (previous_flags >= 0) fcntl(STDOUT_FILENO, F_SETFL, previous_flags | O_NONBLOCK);
    while (!output_failed_) {
      std::string line;
      {
        std::unique_lock<std::mutex> lock(output_lock_);
        output_cv_.wait_for(lock, std::chrono::milliseconds(kIoPollMs), [this] {
          return stopped_ || output_failed_ || !output_.empty();
        });
        if (output_failed_) break;
        if (output_.empty()) {
          if (stopped_) break;
          continue;
        }
        if (stopped_ && output_drain_deadline_ &&
            std::chrono::steady_clock::now() >= *output_drain_deadline_) {
          break;
        }
        line = std::move(output_.front());
        output_bytes_ -= line.size();
        output_.pop_front();
      }
      size_t offset = 0;
      while (offset < line.size()) {
        if (ShutdownOutputDrainExpired()) break;
        pollfd descriptor{STDOUT_FILENO, POLLOUT, 0};
        if (poll(&descriptor, 1, kIoPollMs) <= 0) continue;
        const ssize_t count = write(STDOUT_FILENO, line.data() + offset, line.size() - offset);
        if (count > 0) offset += static_cast<size_t>(count);
        else if (count < 0 && errno != EINTR && errno != EAGAIN) {
          FailOutput(errno == EPIPE ? "stdout pipe closed" : "stdout write failed");
          break;
        }
      }
      if (output_failed_) break;
      if (offset < line.size()) break;
    }
    if (previous_flags >= 0) fcntl(STDOUT_FILENO, F_SETFL, previous_flags);
  }

  void PostInput(std::string frame) {
    {
      std::lock_guard<std::mutex> lock(input_lock_);
      if (stopped_ || pending_input_ >= kMaxPendingRequests) { Diagnose("request queue full"); return; }
      ++pending_input_;
    }
    auto self = shared_from_this();
    if (!CefPostTask(TID_UI, new BridgeTask([self, frame = std::move(frame)]() mutable {
      { std::lock_guard<std::mutex> lock(self->input_lock_); --self->pending_input_; }
      self->ProcessInput(std::move(frame));
    }))) {
      std::lock_guard<std::mutex> failed_lock(input_lock_);
      --pending_input_;
      Diagnose("could not dispatch request");
    }
  }

  void PostClose() {
    if (close_posted_.exchange(true) || stopped_) return;
    auto self = shared_from_this();
    CefPostTask(TID_UI, new BridgeTask([self] { self->RequestClose(); }));
  }

  bool EnqueueJson(const std::string& json) {
    if (json.empty()) { Diagnose("JSON serialization failed"); return false; }
    std::string line = json + "\n";
    std::lock_guard<std::mutex> lock(output_lock_);
    if (stopped_ || output_failed_ || line.size() > kMaxOutputFrameBytes ||
        output_bytes_ + line.size() > kMaxOutputBytes) {
      FailOutput("output queue full");
      return false;
    }
    output_bytes_ += line.size();
    output_.push_back(std::move(line));
    output_cv_.notify_one();
    return true;
  }

  bool ShutdownOutputDrainExpired() {
    if (!stopped_) return false;
    std::lock_guard<std::mutex> lock(output_lock_);
    return output_drain_deadline_ &&
           std::chrono::steady_clock::now() >= *output_drain_deadline_;
  }

  void FailOutput(const char* reason) {
    if (!output_failed_.exchange(true)) {
      Diagnose(reason);
      PostClose();
    }
  }

  std::string WriteJson(CefRefPtr<CefDictionaryValue> dictionary) {
    return CefWriteJSON(NewValue(dictionary), JSON_WRITER_DEFAULT).ToString();
  }

  void ReplyResult(int id, CefRefPtr<CefValue> value) {
    CefRefPtr<CefDictionaryValue> reply = CefDictionaryValue::Create();
    reply->SetInt("id", id);
    reply->SetValue("result", value ? value->Copy() : CefValue::Create());
    if (!EnqueueJson(WriteJson(reply))) {
      ReplyError(id, -32002, "response exceeds host IPC output limit");
    }
  }

  void ReplyError(int id, int code, const std::string& message) {
    CefRefPtr<CefDictionaryValue> error = CefDictionaryValue::Create();
    error->SetInt("code", code);
    error->SetString("message", message);
    CefRefPtr<CefDictionaryValue> reply = CefDictionaryValue::Create();
    reply->SetInt("id", id);
    reply->SetDictionary("error", error);
    EnqueueJson(WriteJson(reply));
  }

  bool RequirePage(int request_id, CefRefPtr<CefDictionaryValue> params,
                   std::string* page_id, CefRefPtr<CefBrowser>* browser) {
    if (!GetString(params, "id", page_id) || !IsPageId(*page_id)) {
      ReplyError(request_id, -32602, "invalid page id"); return false;
    }
    if (page_ids_.find(*page_id) == page_ids_.end()) {
      ReplyError(request_id, -32001, "page is closed or unknown"); return false;
    }
    *browser = manager_ ? manager_->BrowserForPage(*page_id) : nullptr;
    if (!*browser) {
      ReplyError(request_id, -32005, "page browser temporarily unavailable"); return false;
    }
    return true;
  }

  bool IsCurrentPageBrowser(const std::string& page_id,
                            uint32_t generation,
                            CefRefPtr<CefBrowser> browser) const {
    if (!manager_ || !browser || page_ids_.find(page_id) == page_ids_.end()) return false;
    const auto snapshot = manager_->SnapshotForPage(page_id);
    if (!snapshot || !snapshot->browser_available ||
        snapshot->generation != generation) return false;
    const std::optional<std::string> actual = manager_->PageIdForBrowser(browser);
    return actual && *actual == page_id;
  }

  void RetireGeneration(const std::string& page_id, uint32_t generation,
                        const char* message) {
    for (auto it = pending_cdp_.begin(); it != pending_cdp_.end();) {
      if (it->second.page_id == page_id && it->second.generation == generation) {
        ReplyError(it->second.request_id, -32005, message);
        it = pending_cdp_.erase(it);
      } else {
        ++it;
      }
    }
    registrations_.erase(page_id);
    observers_.erase(page_id);
    observer_generations_.erase(page_id);
  }

  void HandleRequest(int request_id, const std::string& method,
                     CefRefPtr<CefDictionaryValue> params) {
    if (method == "pages.list") {
      CefRefPtr<CefListValue> pages = CefListValue::Create();
      size_t index = 0;
      for (const auto& id : page_ids_) {
        CefRefPtr<CefDictionaryValue> item = CefDictionaryValue::Create();
        item->SetString("id", id);
        const auto snapshot = manager_->SnapshotForPage(id);
        if (snapshot) {
          SetGeneration(item, snapshot->generation);
          item->SetBool("browserAvailable", snapshot->browser_available);
          item->SetBool("mainDocumentCommitted", snapshot->main_document_committed);
          item->SetBool("resourcesKnown", snapshot->resources_known);
          item->SetString("url", snapshot->url);
          item->SetString("title", snapshot->title);
          item->SetBool("loading", snapshot->loading);
          item->SetBool("canGoBack", snapshot->can_go_back);
          item->SetBool("canGoForward", snapshot->can_go_forward);
        }
        pages->SetDictionary(index++, item);
      }
      ReplyResult(request_id, NewValue(pages));
      return;
    }
    if (method == "pages.open") {
      if (manager_ && manager_->closing_all()) {
        ReplyError(request_id, -32003, "window is closing"); return;
      }
      std::string id, url;
      if (!GetString(params, "id", &id) || !IsPageId(id) || !GetString(params, "url", &url) || !IsAllowedUrl(url)) {
        ReplyError(request_id, -32602, "invalid page id or URL"); return;
      }
      if (page_ids_.size() >= kMaxPages || !manager_ || !manager_->Open(id, url)) {
        ReplyError(request_id, -32000, "page could not be opened"); return;
      }
      page_ids_.insert(id);
      CefRefPtr<CefDictionaryValue> result = CefDictionaryValue::Create(); result->SetString("id", id);
      ReplyResult(request_id, NewValue(result)); return;
    }
    if (method == "pages.close") {
      std::string id;
      if (!GetString(params, "id", &id) || !IsPageId(id) ||
          page_ids_.find(id) == page_ids_.end() || !manager_) {
        ReplyError(request_id, -32001, "page is closed or unknown"); return;
      }
      const PageCloseResult result = manager_->Close(id);
      if (result == PageCloseResult::kNotFound) ReplyError(request_id, -32001, "page is closed or unknown");
      else ReplyResult(request_id, NewValue(CefDictionaryValue::Create()));
      return;
    }
    if (method == "pages.navigate" || method == "pages.back" || method == "pages.forward" ||
        method == "pages.reload" || method == "pages.stop") {
      std::string id; CefRefPtr<CefBrowser> browser;
      if (!RequirePage(request_id, params, &id, &browser)) return;
      if (method == "pages.navigate") {
        std::string url;
        if (!GetString(params, "url", &url) || !IsAllowedUrl(url)) { ReplyError(request_id, -32602, "invalid URL"); return; }
        browser->GetMainFrame()->LoadURL(url);
      } else if (method == "pages.back") browser->GoBack();
      else if (method == "pages.forward") browser->GoForward();
      else if (method == "pages.reload") browser->Reload();
      else browser->StopLoad();
      ReplyResult(request_id, NewValue(CefDictionaryValue::Create())); return;
    }
    if (method == "viewports.set") { HandleViewports(request_id, params); return; }
    if (method == "window.close") {
      // Begin the root-owned transaction first. This queues window.closing
      // ahead of the acknowledgement on the same FIFO, giving the controller
      // a durable snapshot boundary before an otherwise-fast host exit.
      RequestClose();
      ReplyResult(request_id, NewValue(CefDictionaryValue::Create()));
      return;
    }
    if (method == "window.chrome") {
      if (window_chrome_handler_) ReplyResult(request_id, NewValue(window_chrome_handler_()));
      else ReplyError(request_id, -32601, "window chrome is unavailable");
      return;
    }
    if (method == "ui.commit") {
      if (manager_ && manager_->closing_all()) {
        ReplyError(request_id, -32003, "window is closing"); return;
      }
      if (!ui_commit_handler_) {
        ReplyError(request_id, -32601, "native UI commit is unavailable");
      } else {
        std::string error;
        if (ui_commit_handler_(params, &error)) {
          ReplyResult(request_id, NewValue(CefDictionaryValue::Create()));
        } else {
          ReplyError(request_id, -32602,
                     error.empty() ? "native UI commit rejected" : error);
        }
      }
      return;
    }
    if (method == "cdp.send") { HandleCdp(request_id, params); return; }
    ReplyError(request_id, -32601, "unknown method");
  }

  void HandleViewports(int request_id, CefRefPtr<CefDictionaryValue> params) {
    if (params->GetType("viewports") != VTYPE_LIST) { ReplyError(request_id, -32602, "viewports must be a list"); return; }
    CefRefPtr<CefListValue> input = params->GetList("viewports");
    if (input->GetSize() > kMaxViewports) { ReplyError(request_id, -32602, "too many viewports"); return; }
    std::set<std::string> seen;
    std::vector<PageViewport> viewports;
    for (size_t i = 0; i < input->GetSize(); ++i) {
      CefRefPtr<CefValue> value = input->GetValue(i);
      CefRefPtr<CefDictionaryValue> item = value && value->GetType() == VTYPE_DICTIONARY ? value->GetDictionary() : nullptr;
      std::string id; int x, y, width, height;
      if (!GetString(item, "pageId", &id) || !IsPageId(id) || !seen.insert(id).second ||
          !GetInt(item, "x", &x) || !GetInt(item, "y", &y) || !GetInt(item, "width", &width) || !GetInt(item, "height", &height) ||
          x < 0 || y < 0 || width <= 0 || height <= 0 ||
          x > kMaxCoordinate || y > kMaxCoordinate ||
          width > kMaxCoordinate || height > kMaxCoordinate ||
          x > INT_MAX - width || y > INT_MAX - height ||
          page_ids_.find(id) == page_ids_.end()) {
        ReplyError(request_id, -32602, "invalid viewport"); return;
      }
      viewports.push_back({id, CefRect(x, y, width, height)});
    }
    if (!manager_ || !manager_->SetViewports(viewports)) ReplyError(request_id, -32602, "invalid viewport layout");
    else ReplyResult(request_id, NewValue(CefDictionaryValue::Create()));
  }

  void HandleCdp(int request_id, CefRefPtr<CefDictionaryValue> params) {
    std::string page_id, method; CefRefPtr<CefBrowser> browser;
    if (!GetString(params, "pageId", &page_id) || !IsPageId(page_id) ||
        !GetString(params, "method", &method) || method.empty() || params->GetType("params") != VTYPE_DICTIONARY) {
      ReplyError(request_id, -32602, "invalid CDP request"); return;
    }
    browser = manager_ ? manager_->BrowserForPage(page_id) : nullptr;
    const auto snapshot = manager_ ? manager_->SnapshotForPage(page_id) : std::nullopt;
    if (!snapshot || page_ids_.find(page_id) == page_ids_.end()) {
      ReplyError(request_id, -32001, "page is closed or unknown"); return;
    }
    if (!browser || !snapshot->browser_available) {
      ReplyError(request_id, -32005, "page browser temporarily unavailable"); return;
    }
    const uint32_t generation = snapshot->generation;
    if (observers_.find(page_id) == observers_.end() ||
        observer_generations_[page_id] != generation) {
      RetireGeneration(page_id, observer_generations_[page_id],
                       "browser replaced before DevTools response");
      CefRefPtr<Observer> observer = new Observer(weak_from_this(), page_id, generation);
      CefRefPtr<CefRegistration> registration = browser->GetHost()->AddDevToolsMessageObserver(observer);
      if (!registration) { ReplyError(request_id, -32000, "could not attach DevTools observer"); return; }
      observers_[page_id] = observer;
      registrations_[page_id] = registration;
      observer_generations_[page_id] = generation;
    }
    if (pending_cdp_.size() >= kMaxPendingCdp) {
      ReplyError(request_id, -32003, "too many outstanding DevTools requests");
      return;
    }
    int cdp_id = next_cdp_id_.load();
    while (cdp_id > 0 && cdp_id < INT_MAX &&
           !next_cdp_id_.compare_exchange_weak(cdp_id, cdp_id + 1)) {
    }
    if (cdp_id <= 0 || cdp_id >= INT_MAX) {
      ReplyError(request_id, -32003, "DevTools request ID space exhausted");
      return;
    }
    pending_cdp_.emplace(cdp_id, PendingCdp{request_id, page_id, generation});
    auto self = shared_from_this();
    if (!CefPostDelayedTask(TID_UI, new BridgeTask([self, cdp_id] {
          self->ExpireCdp(cdp_id);
        }), kCdpTimeoutMs)) {
      pending_cdp_.erase(cdp_id);
      ReplyError(request_id, -32000, "could not schedule DevTools timeout");
      return;
    }
    if (browser->GetHost()->ExecuteDevToolsMethod(cdp_id, method, params->GetDictionary("params")) != cdp_id) {
      pending_cdp_.erase(cdp_id);
      ReplyError(request_id, -32000, "could not execute DevTools method");
    }
  }

  void ExpireCdp(int cdp_id) {
    CEF_REQUIRE_UI_THREAD();
    auto it = pending_cdp_.find(cdp_id);
    if (stopped_ || it == pending_cdp_.end()) return;
    const int request_id = it->second.request_id;
    pending_cdp_.erase(it);
    ReplyError(request_id, -32004, "DevTools request timed out");
  }

  CefRefPtr<PageManager> manager_;
  CefRefPtr<CefWindow> root_;
  std::set<std::string> page_ids_;
  std::map<std::string, CefRefPtr<Observer>> observers_;
  std::map<std::string, CefRefPtr<CefRegistration>> registrations_;
  std::map<std::string, uint32_t> observer_generations_;
  std::map<int, PendingCdp> pending_cdp_;
  EngineBridge::UiCommitHandler ui_commit_handler_;
  EngineBridge::WindowChromeHandler window_chrome_handler_;
  EngineBridge::CloseRequestHandler close_request_handler_;
  std::atomic<bool> stopped_{false};
  bool started_ = false;
  std::thread reader_;
  std::thread writer_;
  std::mutex input_lock_;
  size_t pending_input_ = 0;
  std::atomic<bool> close_posted_{false};
  std::atomic<bool> output_failed_{false};
  std::mutex output_lock_;
  std::condition_variable output_cv_;
  std::deque<std::string> output_;
  size_t output_bytes_ = 0;
  std::optional<std::chrono::steady_clock::time_point> output_drain_deadline_;
};

std::atomic<int> EngineBridge::Core::next_cdp_id_{1};

CefRefPtr<EngineBridge> EngineBridge::Create(CefRefPtr<PageManager> manager,
                                              CefRefPtr<CefWindow> root_window) {
  CEF_REQUIRE_UI_THREAD();
  if (!manager || !root_window) return nullptr;
  return new EngineBridge(manager, root_window);
}

EngineBridge::EngineBridge(CefRefPtr<PageManager> manager,
                           CefRefPtr<CefWindow> root_window)
    : core_(std::make_shared<Core>(manager, root_window)) {}

EngineBridge::~EngineBridge() { core_->Stop(); }
void EngineBridge::Start() { core_->Start(); }
void EngineBridge::Stop() { core_->Stop(); }
void EngineBridge::OnPageEvent(const PageEvent& event) { core_->OnPageEvent(event); }
void EngineBridge::SendEvent(const std::string& name, CefRefPtr<CefDictionaryValue> params) {
  core_->SendEvent(name, params);
}
void EngineBridge::SetUiCommitHandler(UiCommitHandler handler) {
  core_->SetUiCommitHandler(std::move(handler));
}

void EngineBridge::SetCloseRequestHandler(CloseRequestHandler handler) {
  core_->SetCloseRequestHandler(std::move(handler));
}
void EngineBridge::SetWindowChromeHandler(WindowChromeHandler handler) {
  core_->SetWindowChromeHandler(std::move(handler));
}
