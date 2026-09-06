// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights
// reserved. Use of this source code is governed by a BSD-style license that
// can be found in the LICENSE file.

#ifndef CEF_TESTS_CEFSIMPLE_SIMPLE_HANDLER_H_
#define CEF_TESTS_CEFSIMPLE_SIMPLE_HANDLER_H_

#include <functional>
#include <list>
#include <map>
#include <set>

#include "include/cef_client.h"
#include "include/cef_jsdialog_handler.h"

class PageManager;
class CefWindow;

class SimpleHandler : public CefClient,
                      public CefDisplayHandler,
                      public CefLifeSpanHandler,
                      public CefLoadHandler,
                      public CefJSDialogHandler {
 public:
  using ShellCloseCancelledCallback = std::function<void()>;

  explicit SimpleHandler(bool is_alloy_style);
  ~SimpleHandler() override;

  // Provide access to the single global instance of this object.
  static SimpleHandler* GetInstance();

  void SetShell(CefWindow* shell,
                PageManager* manager,
                ShellCloseCancelledCallback close_cancelled_callback = {});
  // Clears root-owned references after native window destruction while
  // preserving the shutdown gate until all browsers and accepted popups drain.
  void OnShellDestroyed();
  void SetShellClosing(bool closing);
  bool CanCloseShell();

  // CefClient methods:
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefJSDialogHandler> GetJSDialogHandler() override { return this; }

  // CefDisplayHandler methods:
  void OnTitleChange(CefRefPtr<CefBrowser> browser,
                     const CefString& title) override;

  // CefLifeSpanHandler methods:
  bool OnBeforePopup(CefRefPtr<CefBrowser> browser,
                     CefRefPtr<CefFrame> frame,
                     int popup_id,
                     const CefString& target_url,
                     const CefString& target_frame_name,
                     WindowOpenDisposition target_disposition,
                     bool user_gesture,
                     const CefPopupFeatures& popup_features,
                     CefWindowInfo& window_info,
                     CefRefPtr<CefClient>& client,
                     CefBrowserSettings& settings,
                     CefRefPtr<CefDictionaryValue>& extra_info,
                     bool* no_javascript_access) override;
  void OnBeforePopupAborted(CefRefPtr<CefBrowser> browser,
                            int popup_id) override;
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
  bool DoClose(CefRefPtr<CefBrowser> browser) override;
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override;

  // CefLoadHandler methods:
  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode errorCode,
                   const CefString& errorText,
                   const CefString& failedUrl) override;

  // CefJSDialogHandler methods:
  bool OnBeforeUnloadDialog(CefRefPtr<CefBrowser> browser,
                            const CefString& message_text,
                            bool is_reload,
                            CefRefPtr<CefJSDialogCallback> callback) override;
  void OnResetDialogState(CefRefPtr<CefBrowser> browser) override;

  void ShowMainWindow();

  // Request that all existing browser windows close.
  void CloseAllBrowsers(bool force_close);

  bool IsClosing() const { return shell_ ? shell_closing_ : is_closing_; }

 private:
  // Platform-specific implementation.
  void PlatformTitleChange(CefRefPtr<CefBrowser> browser,
                           const CefString& title);
  void PlatformShowWindow(CefRefPtr<CefBrowser> browser);
  void FinishPendingPopup(int opener_browser_id);
  void MaybeFinishShellClose();

  // True if this client is Alloy style, otherwise Chrome style.
  const bool is_alloy_style_;

  // List of existing browser windows. Only accessed on the CEF UI thread.
  typedef std::list<CefRefPtr<CefBrowser>> BrowserList;
  BrowserList browser_list_;

  bool is_closing_ = false;
  // The manager pointer is nonowning and cleared by the root before manager
  // teardown. Holding the CEF window reference is safe because the root clears
  // this hook from OnWindowDestroyed.
  CefRefPtr<CefWindow> shell_;
  PageManager* page_manager_ = nullptr;
  ShellCloseCancelledCallback shell_close_cancelled_callback_;
  bool shell_closing_ = false;
  bool shell_close_retry_posted_ = false;
  std::set<int> unmanaged_close_requests_;
  std::map<int, size_t> pending_popups_by_opener_;
  size_t pending_popup_count_ = 0;

  // Include the default reference counting implementation.
  IMPLEMENT_REFCOUNTING(SimpleHandler);
};

#endif  // CEF_TESTS_CEFSIMPLE_SIMPLE_HANDLER_H_
