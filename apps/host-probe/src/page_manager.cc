// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights
// reserved. Use of this source code is governed by a BSD-style license that
// can be found in the LICENSE file.

#include "src/page_manager.h"

#include <algorithm>
#include <cstdint>
#include <map>
#include <set>
#include <utility>

#include "include/cef_request_context.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_browser_view_delegate.h"
#include "include/views/cef_fill_layout.h"
#include "include/views/cef_window_delegate.h"
#include "include/wrapper/cef_helpers.h"

namespace {

constexpr int kFallbackWindowSize = 1;

bool IsValidPageId(const std::string& page_id) {
  return !page_id.empty();
}

bool IsValidRect(const CefRect& rect) {
  return rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0;
}

bool RectsOverlap(const CefRect& lhs, const CefRect& rhs) {
  const int64_t lhs_right = static_cast<int64_t>(lhs.x) + lhs.width;
  const int64_t lhs_bottom = static_cast<int64_t>(lhs.y) + lhs.height;
  const int64_t rhs_right = static_cast<int64_t>(rhs.x) + rhs.width;
  const int64_t rhs_bottom = static_cast<int64_t>(rhs.y) + rhs.height;
  return static_cast<int64_t>(lhs.x) < rhs_right &&
         static_cast<int64_t>(rhs.x) < lhs_right &&
         static_cast<int64_t>(lhs.y) < rhs_bottom &&
         static_cast<int64_t>(rhs.y) < lhs_bottom;
}

}  // namespace

class PageManagerCore : public std::enable_shared_from_this<PageManagerCore> {
 public:
  PageManagerCore(CefRefPtr<CefWindow> root_window,
                  CefRefPtr<CefClient> shared_client,
                  PageManager::EventCallback event_callback)
      : root_window_(root_window),
        shared_client_(shared_client),
        request_context_(CefRequestContext::GetGlobalContext()),
        event_callback_(std::move(event_callback)) {}

  ~PageManagerCore() { DisableCallbacksAndRelease(); }

  bool Open(const std::string& page_id, const CefString& url);
  PageCloseResult Close(const std::string& page_id);
  size_t CloseAll();
  void CancelCloseAll();
  bool AcknowledgeCloseCancelled(CefRefPtr<CefBrowser> browser);
  bool SetViewports(const std::vector<PageViewport>& viewports);
  void Layout();
  CefRefPtr<CefBrowser> BrowserForPage(const std::string& page_id) const;
  std::optional<std::string> PageIdForBrowser(
      CefRefPtr<CefBrowser> browser) const;
  void NotifyTitleChanged(CefRefPtr<CefBrowser> browser,
                          const CefString& title);
  void NotifyNavigationChanged(CefRefPtr<CefBrowser> browser);
  void NotifyAudioChanged(CefRefPtr<CefBrowser> browser, bool active);
  void NotifyCallChanged(CefRefPtr<CefBrowser> browser, bool active);
  void NotifyDownloadChanged(CefRefPtr<CefBrowser> browser, bool active);
  void NotifyContentEdited(CefRefPtr<CefBrowser> browser);

  bool empty() const { return pages_.empty(); }
  bool closing_all() const { return closing_all_; }

  CefRect InitialBounds() const;
  CefRefPtr<CefWindow> root_window() const { return root_window_; }

  void OnWindowCreated(const std::string& page_id,
                       CefRefPtr<CefWindow> window);
  void OnWindowReady(const std::string& page_id);
  void OnWindowDestroyed(const std::string& page_id);
  void OnBrowserCreated(const std::string& page_id,
                        CefRefPtr<CefBrowser> browser);
  void OnBrowserDestroyed(const std::string& page_id,
                          CefRefPtr<CefBrowser> browser);

  void DisableCallbacksAndRelease();

 private:
  struct PageRecord {
    CefRefPtr<CefBrowserView> browser_view;
    CefRefPtr<CefWindow> window;
    CefRefPtr<CefBrowser> browser;
    bool browser_created = false;
    bool browser_destroyed = false;
    bool window_destroyed = false;
    bool close_requested = false;
    bool audio = false;
    bool call = false;
    bool download = false;
    bool unsaved_input = false;
    // Default to the ordinary page-close semantic for a page window that CEF
    // closes outside an explicit manager request.
    PageEvent::CloseReason close_reason = PageEvent::CloseReason::kPageClose;
  };

  using PageMap = std::map<std::string, PageRecord>;
  using ViewportMap = std::map<std::string, CefRect>;

  void ApplyPageLayout(const std::string& page_id, PageRecord& page);
  void TryFinalize(const std::string& page_id);
  void Emit(PageEvent event);
  void EmitResources(const std::string& page_id, CefRefPtr<CefBrowser> browser,
                     const PageRecord& page);

  CefRefPtr<CefWindow> root_window_;
  CefRefPtr<CefClient> shared_client_;
  CefRefPtr<CefRequestContext> request_context_;
  PageManager::EventCallback event_callback_;
  PageMap pages_;
  ViewportMap viewports_;
  bool closing_all_ = false;
  bool callbacks_enabled_ = true;
};

namespace {

class PageWindowDelegate : public CefWindowDelegate {
 public:
  PageWindowDelegate(std::weak_ptr<PageManagerCore> manager,
                     std::string page_id,
                     CefRefPtr<CefBrowserView> browser_view)
      : manager_(std::move(manager)),
        page_id_(std::move(page_id)),
        browser_view_(browser_view) {}

  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    CEF_REQUIRE_UI_THREAD();
    if (auto manager = manager_.lock()) {
      manager->OnWindowCreated(page_id_, window);
    }

    window->SetToFillLayout();
    window->AddChildView(browser_view_);

    if (auto manager = manager_.lock()) {
      manager->OnWindowReady(page_id_);
    }
  }

  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    CEF_REQUIRE_UI_THREAD();
    if (auto manager = manager_.lock()) {
      manager->OnWindowDestroyed(page_id_);
    }
    browser_view_ = nullptr;
  }

  CefRefPtr<CefWindow> GetParentWindow(CefRefPtr<CefWindow> window,
                                       bool* is_menu,
                                       bool* can_activate_menu) override {
    CEF_REQUIRE_UI_THREAD();
    *is_menu = false;
    *can_activate_menu = true;
    if (auto manager = manager_.lock()) {
      return manager->root_window();
    }
    return nullptr;
  }

  bool IsWindowModalDialog(CefRefPtr<CefWindow> window) override {
    return false;
  }

  CefRect GetInitialBounds(CefRefPtr<CefWindow> window) override {
    CEF_REQUIRE_UI_THREAD();
    if (auto manager = manager_.lock()) {
      return manager->InitialBounds();
    }
    return CefRect(0, 0, kFallbackWindowSize, kFallbackWindowSize);
  }

  cef_show_state_t GetInitialShowState(CefRefPtr<CefWindow> window) override {
    return CEF_SHOW_STATE_HIDDEN;
  }

  cef_runtime_style_t GetWindowRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_CHROME;
  }

  bool IsFrameless(CefRefPtr<CefWindow> window) override { return true; }
  bool WithStandardWindowButtons(CefRefPtr<CefWindow> window) override {
    return false;
  }
  cef_state_t AcceptsFirstMouse(CefRefPtr<CefWindow> window) override {
    // Split view pages should receive the click that activates their child
    // window instead of requiring a second click.
    return STATE_ENABLED;
  }
  bool CanResize(CefRefPtr<CefWindow> window) override { return false; }
  bool CanMaximize(CefRefPtr<CefWindow> window) override { return false; }
  bool CanMinimize(CefRefPtr<CefWindow> window) override { return false; }

  bool CanClose(CefRefPtr<CefWindow> window) override {
    CEF_REQUIRE_UI_THREAD();
    if (browser_view_) {
      if (auto browser = browser_view_->GetBrowser()) {
        return browser->GetHost()->TryCloseBrowser();
      }
    }
    return true;
  }

 private:
  std::weak_ptr<PageManagerCore> manager_;
  const std::string page_id_;
  CefRefPtr<CefBrowserView> browser_view_;

  IMPLEMENT_REFCOUNTING(PageWindowDelegate);
  DISALLOW_COPY_AND_ASSIGN(PageWindowDelegate);
};

class PageBrowserViewDelegate : public CefBrowserViewDelegate {
 public:
  PageBrowserViewDelegate(std::weak_ptr<PageManagerCore> manager,
                          std::string page_id)
      : manager_(std::move(manager)), page_id_(std::move(page_id)) {}

  void OnBrowserCreated(CefRefPtr<CefBrowserView> browser_view,
                        CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    if (auto manager = manager_.lock()) {
      manager->OnBrowserCreated(page_id_, browser);
    }
  }

  void OnBrowserDestroyed(CefRefPtr<CefBrowserView> browser_view,
                          CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    if (auto manager = manager_.lock()) {
      manager->OnBrowserDestroyed(page_id_, browser);
    }
  }

  CefRefPtr<CefBrowserViewDelegate> GetDelegateForPopupBrowserView(
      CefRefPtr<CefBrowserView> browser_view,
      const CefBrowserSettings& settings,
      CefRefPtr<CefClient> client,
      bool is_devtools) override {
    // A popup is not another binding of this page. Returning no delegate keeps
    // its lifecycle separate from the stable Hitchhiker page ID.
    return nullptr;
  }

  bool OnPopupBrowserViewCreated(CefRefPtr<CefBrowserView> browser_view,
                                 CefRefPtr<CefBrowserView> popup_browser_view,
                                 bool is_devtools) override {
    // Let CEF create the default popup window. The shared CefClient still owns
    // popup policy and lifetime; PageManager only manages explicitly opened
    // page surfaces.
    return false;
  }

  cef_runtime_style_t GetBrowserRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_CHROME;
  }

 private:
  std::weak_ptr<PageManagerCore> manager_;
  const std::string page_id_;

  IMPLEMENT_REFCOUNTING(PageBrowserViewDelegate);
  DISALLOW_COPY_AND_ASSIGN(PageBrowserViewDelegate);
};

}  // namespace

bool PageManagerCore::Open(const std::string& page_id, const CefString& url) {
  CEF_REQUIRE_UI_THREAD();
  if (closing_all_ || !root_window_ || !shared_client_ || !request_context_ ||
      !IsValidPageId(page_id) || pages_.find(page_id) != pages_.end()) {
    return false;
  }

  CefBrowserSettings browser_settings;
  CefRefPtr<CefBrowserView> browser_view = CefBrowserView::CreateBrowserView(
      shared_client_, url, browser_settings, nullptr, request_context_,
      new PageBrowserViewDelegate(weak_from_this(), page_id));
  if (!browser_view) {
    return false;
  }

  PageRecord page;
  page.browser_view = browser_view;
  pages_.emplace(page_id, std::move(page));

  CefWindow::CreateTopLevelWindow(
      new PageWindowDelegate(weak_from_this(), page_id, browser_view));
  return true;
}

PageCloseResult PageManagerCore::Close(const std::string& page_id) {
  CEF_REQUIRE_UI_THREAD();
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    return PageCloseResult::kNotFound;
  }

  PageRecord& page = it->second;
  if (page.close_requested) {
    return PageCloseResult::kAlreadyRequested;
  }
  page.close_requested = true;
  page.close_reason = PageEvent::CloseReason::kPageClose;

  if (page.browser) {
    page.browser->GetHost()->CloseBrowser(false);
  } else if (page.window) {
    page.window->Close();
  }
  return PageCloseResult::kRequested;
}

size_t PageManagerCore::CloseAll() {
  CEF_REQUIRE_UI_THREAD();
  if (closing_all_) {
    return pages_.size();
  }
  closing_all_ = true;

  // Session persistence needs this before any child page is eligible to
  // drain. Do not derive page reasons from closing_all_: an unload dialog can
  // cancel this batch while other pages still finish closing.
  Emit(PageEvent{PageEvent::Type::kWindowClosing, {}});

  std::vector<CefRefPtr<CefBrowser>> browsers;
  std::vector<CefRefPtr<CefWindow>> windows_without_browsers;
  browsers.reserve(pages_.size());
  windows_without_browsers.reserve(pages_.size());
  for (auto& [page_id, page] : pages_) {
    // Preserve an earlier explicit page close. That page is not part of the
    // session-close transaction even if root shutdown starts while it drains.
    if (!page.close_requested) {
      page.close_reason = PageEvent::CloseReason::kWindowClose;
    }
    page.close_requested = true;
    if (page.browser) {
      browsers.push_back(page.browser);
    } else if (page.window) {
      windows_without_browsers.push_back(page.window);
    }
  }

  for (auto& browser : browsers) {
    browser->GetHost()->CloseBrowser(false);
  }
  for (auto& window : windows_without_browsers) {
    window->Close();
  }
  return pages_.size();
}

void PageManagerCore::CancelCloseAll() {
  CEF_REQUIRE_UI_THREAD();
  if (!closing_all_) {
    return;
  }
  closing_all_ = false;
  Emit(PageEvent{PageEvent::Type::kWindowCloseCancelled, {}});
}

bool PageManagerCore::AcknowledgeCloseCancelled(
    CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  auto page_id = PageIdForBrowser(browser);
  if (!page_id) {
    return false;
  }

  auto it = pages_.find(*page_id);
  if (it == pages_.end() || !it->second.close_requested ||
      !it->second.browser ||
      it->second.browser->GetHost()->IsReadyToBeClosed()) {
    return false;
  }

  it->second.close_requested = false;
  it->second.close_reason = PageEvent::CloseReason::kPageClose;
  // Other pages from the same close batch may still complete closing. The
  // canceled page can resume immediately. Finish the batch before emitting
  // the page event, so callers that only observe PageManager still restore
  // their working session even without an outer shell callback.
  CancelCloseAll();

  PageEvent event{PageEvent::kCloseCancelled, *page_id};
  event.browser = it->second.browser;
  event.remaining_pages = pages_.size();
  Emit(std::move(event));
  return true;
}

bool PageManagerCore::SetViewports(
    const std::vector<PageViewport>& viewports) {
  CEF_REQUIRE_UI_THREAD();
  if (closing_all_ || !root_window_) {
    return false;
  }

  const CefRect root_bounds = root_window_->GetClientAreaBoundsInScreen();
  std::set<std::string> seen_ids;
  ViewportMap next_viewports;
  for (const auto& viewport : viewports) {
    const auto page_it = pages_.find(viewport.page_id);
    if (page_it == pages_.end() || page_it->second.close_requested ||
        !seen_ids.insert(viewport.page_id).second ||
        !IsValidRect(viewport.bounds)) {
      return false;
    }

    const int64_t right =
        static_cast<int64_t>(viewport.bounds.x) + viewport.bounds.width;
    const int64_t bottom =
        static_cast<int64_t>(viewport.bounds.y) + viewport.bounds.height;
    if (right > root_bounds.width || bottom > root_bounds.height) {
      return false;
    }

    for (const auto& [other_id, other_bounds] : next_viewports) {
      if (RectsOverlap(viewport.bounds, other_bounds)) {
        return false;
      }
    }
    next_viewports.emplace(viewport.page_id, viewport.bounds);
  }

  viewports_ = std::move(next_viewports);
  Layout();
  return true;
}

void PageManagerCore::Layout() {
  CEF_REQUIRE_UI_THREAD();
  if (!root_window_) {
    return;
  }
  for (auto& [page_id, page] : pages_) {
    ApplyPageLayout(page_id, page);
  }
}

CefRefPtr<CefBrowser> PageManagerCore::BrowserForPage(
    const std::string& page_id) const {
  CEF_REQUIRE_UI_THREAD();
  const auto it = pages_.find(page_id);
  return it == pages_.end() ? nullptr : it->second.browser;
}

std::optional<std::string> PageManagerCore::PageIdForBrowser(
    CefRefPtr<CefBrowser> browser) const {
  CEF_REQUIRE_UI_THREAD();
  if (!browser) {
    return std::nullopt;
  }
  for (const auto& [page_id, page] : pages_) {
    if (page.browser && page.browser->IsSame(browser)) {
      return page_id;
    }
  }
  return std::nullopt;
}

void PageManagerCore::NotifyTitleChanged(CefRefPtr<CefBrowser> browser,
                                         const CefString& title) {
  CEF_REQUIRE_UI_THREAD();
  auto page_id = PageIdForBrowser(browser);
  if (!page_id) {
    return;
  }
  PageEvent event{PageEvent::Type::kTitleChanged, *page_id};
  event.browser = browser;
  event.title = title;
  Emit(std::move(event));
}

void PageManagerCore::NotifyNavigationChanged(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  auto page_id = PageIdForBrowser(browser);
  if (!page_id) return;
  auto page = pages_.find(*page_id);
  if (page == pages_.end()) return;
  const bool clear_unsaved_input = page->second.unsaved_input;
  page->second.unsaved_input = false;
  PageEvent event{PageEvent::Type::kNavigationChanged, *page_id};
  event.browser = browser;
  Emit(std::move(event));
  if (clear_unsaved_input) {
    // Event callbacks can synchronously start teardown. Re-find the record
    // before using it after the navigation event is delivered.
    page = pages_.find(*page_id);
    if (page != pages_.end()) EmitResources(*page_id, browser, page->second);
  }
}

void PageManagerCore::NotifyAudioChanged(CefRefPtr<CefBrowser> browser, bool active) {
  CEF_REQUIRE_UI_THREAD();
  const auto page_id = PageIdForBrowser(browser);
  if (!page_id) return;
  PageRecord& page = pages_.at(*page_id);
  if (page.audio == active) return;
  page.audio = active;
  EmitResources(*page_id, browser, page);
}

void PageManagerCore::NotifyCallChanged(CefRefPtr<CefBrowser> browser, bool active) {
  CEF_REQUIRE_UI_THREAD();
  const auto page_id = PageIdForBrowser(browser);
  if (!page_id) return;
  PageRecord& page = pages_.at(*page_id);
  if (page.call == active) return;
  page.call = active;
  EmitResources(*page_id, browser, page);
}

void PageManagerCore::NotifyDownloadChanged(CefRefPtr<CefBrowser> browser, bool active) {
  CEF_REQUIRE_UI_THREAD();
  const auto page_id = PageIdForBrowser(browser);
  if (!page_id) return;
  PageRecord& page = pages_.at(*page_id);
  if (page.download == active) return;
  page.download = active;
  EmitResources(*page_id, browser, page);
}

void PageManagerCore::NotifyContentEdited(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  const auto page_id = PageIdForBrowser(browser);
  if (!page_id) return;
  PageRecord& page = pages_.at(*page_id);
  if (page.unsaved_input) return;
  page.unsaved_input = true;
  EmitResources(*page_id, browser, page);
}

void PageManagerCore::EmitResources(const std::string& page_id,
                                    CefRefPtr<CefBrowser> browser,
                                    const PageRecord& page) {
  PageEvent event{PageEvent::Type::kResourcesChanged, page_id};
  event.browser = browser;
  event.audio = page.audio;
  event.call = page.call;
  event.download = page.download;
  event.unsaved_input = page.unsaved_input;
  Emit(std::move(event));
}

CefRect PageManagerCore::InitialBounds() const {
  CEF_REQUIRE_UI_THREAD();
  if (root_window_) {
    const CefRect root_bounds = root_window_->GetClientAreaBoundsInScreen();
    return CefRect(root_bounds.x, root_bounds.y, kFallbackWindowSize,
                   kFallbackWindowSize);
  }
  return CefRect(0, 0, kFallbackWindowSize, kFallbackWindowSize);
}

void PageManagerCore::OnWindowCreated(const std::string& page_id,
                                      CefRefPtr<CefWindow> window) {
  CEF_REQUIRE_UI_THREAD();
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    window->Close();
    return;
  }
  it->second.window = window;
}

void PageManagerCore::OnWindowReady(const std::string& page_id) {
  CEF_REQUIRE_UI_THREAD();
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    return;
  }
  ApplyPageLayout(page_id, it->second);
  if (it->second.close_requested && it->second.browser) {
    it->second.browser->GetHost()->CloseBrowser(false);
  }
}

void PageManagerCore::OnWindowDestroyed(const std::string& page_id) {
  CEF_REQUIRE_UI_THREAD();
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    return;
  }
  it->second.window = nullptr;
  it->second.window_destroyed = true;
  if (!it->second.browser_created) {
    it->second.browser_destroyed = true;
    it->second.browser_view = nullptr;
  }
  TryFinalize(page_id);
}

void PageManagerCore::OnBrowserCreated(const std::string& page_id,
                                       CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    browser->GetHost()->CloseBrowser(false);
    return;
  }

  PageRecord& page = it->second;
  page.browser = browser;
  page.browser_created = true;

  PageEvent event{PageEvent::Type::kCreated, page_id};
  event.browser = browser;
  Emit(std::move(event));
  // A complete initial snapshot lets the trusted runtime distinguish an idle
  // page from a page whose protection state is simply unknown.
  EmitResources(page_id, browser, page);

  if (page.close_requested) {
    browser->GetHost()->CloseBrowser(false);
  }
}

void PageManagerCore::OnBrowserDestroyed(const std::string& page_id,
                                         CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    return;
  }
  if (it->second.browser && !it->second.browser->IsSame(browser)) {
    return;
  }
  it->second.browser = nullptr;
  it->second.browser_view = nullptr;
  it->second.browser_destroyed = true;
  TryFinalize(page_id);
}

void PageManagerCore::DisableCallbacksAndRelease() {
  callbacks_enabled_ = false;
  event_callback_ = {};
  viewports_.clear();
  pages_.clear();
  request_context_ = nullptr;
  shared_client_ = nullptr;
  root_window_ = nullptr;
}

void PageManagerCore::ApplyPageLayout(const std::string& page_id,
                                      PageRecord& page) {
  if (!page.window) {
    return;
  }
  const auto viewport_it = viewports_.find(page_id);
  if (viewport_it == viewports_.end()) {
    if (page.window->IsVisible()) {
      page.window->Hide();
    }
    return;
  }

  const CefRect root_bounds = root_window_->GetClientAreaBoundsInScreen();
  const CefRect& relative = viewport_it->second;
  page.window->SetBounds(CefRect(root_bounds.x + relative.x,
                                 root_bounds.y + relative.y, relative.width,
                                 relative.height));
  if (!page.window->IsVisible()) {
    page.window->Show();
  }
}

void PageManagerCore::TryFinalize(const std::string& page_id) {
  auto it = pages_.find(page_id);
  if (it == pages_.end() || !it->second.browser_destroyed ||
      !it->second.window_destroyed) {
    return;
  }

  const PageEvent::CloseReason close_reason = it->second.close_reason;
  pages_.erase(it);
  viewports_.erase(page_id);

  PageEvent event{PageEvent::Type::kClosed, page_id};
  event.close_reason = close_reason;
  event.remaining_pages = pages_.size();
  Emit(std::move(event));
}

void PageManagerCore::Emit(PageEvent event) {
  if (callbacks_enabled_ && event_callback_) {
    event_callback_(event);
  }
}

// static
CefRefPtr<PageManager> PageManager::Create(
    CefRefPtr<CefWindow> root_window,
    CefRefPtr<CefClient> shared_client,
    EventCallback event_callback) {
  CEF_REQUIRE_UI_THREAD();
  if (!root_window || !shared_client) {
    return nullptr;
  }
  return new PageManager(root_window, shared_client, std::move(event_callback));
}

PageManager::PageManager(CefRefPtr<CefWindow> root_window,
                         CefRefPtr<CefClient> shared_client,
                         EventCallback event_callback)
    : core_(std::make_shared<PageManagerCore>(
          root_window, shared_client, std::move(event_callback))) {}

PageManager::~PageManager() {
  if (core_) {
    core_->DisableCallbacksAndRelease();
  }
}

bool PageManager::Open(const std::string& page_id, const CefString& url) {
  return core_->Open(page_id, url);
}

PageCloseResult PageManager::Close(const std::string& page_id) {
  return core_->Close(page_id);
}

size_t PageManager::CloseAll() {
  return core_->CloseAll();
}

void PageManager::CancelCloseAll() {
  core_->CancelCloseAll();
}

bool PageManager::AcknowledgeCloseCancelled(
    CefRefPtr<CefBrowser> browser) {
  return core_->AcknowledgeCloseCancelled(browser);
}

bool PageManager::SetViewports(
    const std::vector<PageViewport>& viewports) {
  return core_->SetViewports(viewports);
}

void PageManager::Layout() {
  core_->Layout();
}

CefRefPtr<CefBrowser> PageManager::BrowserForPage(
    const std::string& page_id) const {
  return core_->BrowserForPage(page_id);
}

std::optional<std::string> PageManager::PageIdForBrowser(
    CefRefPtr<CefBrowser> browser) const {
  return core_->PageIdForBrowser(browser);
}

void PageManager::NotifyTitleChanged(CefRefPtr<CefBrowser> browser,
                                     const CefString& title) {
  core_->NotifyTitleChanged(browser, title);
}

void PageManager::NotifyNavigationChanged(CefRefPtr<CefBrowser> browser) {
  core_->NotifyNavigationChanged(browser);
}

void PageManager::NotifyAudioChanged(CefRefPtr<CefBrowser> browser, bool active) {
  core_->NotifyAudioChanged(browser, active);
}

void PageManager::NotifyCallChanged(CefRefPtr<CefBrowser> browser, bool active) {
  core_->NotifyCallChanged(browser, active);
}

void PageManager::NotifyDownloadChanged(CefRefPtr<CefBrowser> browser, bool active) {
  core_->NotifyDownloadChanged(browser, active);
}

void PageManager::NotifyContentEdited(CefRefPtr<CefBrowser> browser) {
  core_->NotifyContentEdited(browser);
}

bool PageManager::empty() const {
  return core_->empty();
}

bool PageManager::closing_all() const {
  return core_->closing_all();
}
