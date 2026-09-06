// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights
// reserved. Use of this source code is governed by a BSD-style license that
// can be found in the LICENSE file.

#include "src/simple_handler.h"

#include <sstream>
#include <string>
#include <vector>

#include "include/base/cef_callback.h"
#include "include/cef_app.h"
#include "include/cef_parser.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"
#include "src/before_unload_dialog.h"
#include "src/page_manager.h"

namespace {

SimpleHandler* g_instance = nullptr;

constexpr int kWindowsBackspace = 0x08;
constexpr int kWindowsDelete = 0x2E;
constexpr int kWindowsV = 0x56;

bool IsEditableMutation(const CefKeyEvent& event) {
  if (!event.focus_on_editable_field) return false;
  if (event.type == KEYEVENT_CHAR) {
    // CEF normalizes text insertion to KEYEVENT_CHAR. Control characters are
    // navigation/commands, not content edits.
    return event.character >= 0x20 && event.character != 0x7f;
  }
  if (event.type != KEYEVENT_RAWKEYDOWN) return false;
  if (event.windows_key_code == kWindowsBackspace ||
      event.windows_key_code == kWindowsDelete) return true;
  const bool command = (event.modifiers & EVENTFLAG_COMMAND_DOWN) != 0;
  const bool control = (event.modifiers & EVENTFLAG_CONTROL_DOWN) != 0;
  return (command || control) && event.windows_key_code == kWindowsV;
}

// Returns a data: URI with the specified contents.
std::string GetDataURI(const std::string& data, const std::string& mime_type) {
  return "data:" + mime_type + ";base64," +
         CefURIEncode(CefBase64Encode(data.data(), data.size()), false)
             .ToString();
}

}  // namespace

SimpleHandler::SimpleHandler(bool is_alloy_style)
    : is_alloy_style_(is_alloy_style) {
  DCHECK(!g_instance);
  g_instance = this;
}

SimpleHandler::~SimpleHandler() {
  g_instance = nullptr;
}

// static
SimpleHandler* SimpleHandler::GetInstance() {
  return g_instance;
}

bool SimpleHandler::OnBeforePopup(
    CefRefPtr<CefBrowser> browser,
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
    bool* no_javascript_access) {
  CEF_REQUIRE_UI_THREAD();
  if (shell_closing_) {
    return true;
  }

  ++pending_popups_by_opener_[browser->GetIdentifier()];
  ++pending_popup_count_;
  return false;
}

void SimpleHandler::OnBeforePopupAborted(CefRefPtr<CefBrowser> browser,
                                         int popup_id) {
  CEF_REQUIRE_UI_THREAD();
  FinishPendingPopup(browser->GetIdentifier());
}

void SimpleHandler::OnTitleChange(CefRefPtr<CefBrowser> browser,
                                  const CefString& title) {
  CEF_REQUIRE_UI_THREAD();
  if (page_manager_) page_manager_->NotifyTitleChanged(browser, title);

  if (auto browser_view = CefBrowserView::GetForBrowser(browser)) {
    // Set the title of the window using the Views framework.
    CefRefPtr<CefWindow> window = browser_view->GetWindow();
    if (window) {
      window->SetTitle(title);
    }
  } else if (is_alloy_style_) {
    // Set the title of the window using platform APIs.
    PlatformTitleChange(browser, title);
  }
}

void SimpleHandler::OnAddressChange(CefRefPtr<CefBrowser> browser,
                                    CefRefPtr<CefFrame> frame, const CefString&) {
  CEF_REQUIRE_UI_THREAD();
  if (page_manager_ && frame->IsMain()) page_manager_->NotifyNavigationChanged(browser);
}

void SimpleHandler::OnMediaAccessChange(CefRefPtr<CefBrowser> browser,
                                        bool has_video_access,
                                        bool has_audio_access) {
  CEF_REQUIRE_UI_THREAD();
  // Active capture is conservatively treated as a call. The callback reports
  // current access, unlike a permission request which can outlive a call.
  if (page_manager_)
    page_manager_->NotifyCallChanged(browser, has_video_access || has_audio_access);
}

void SimpleHandler::OnLoadingStateChange(CefRefPtr<CefBrowser> browser, bool, bool, bool) {
  CEF_REQUIRE_UI_THREAD();
  if (page_manager_) page_manager_->NotifyNavigationChanged(browser);
}

void SimpleHandler::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();

  if (!shell_closing_) {
    is_closing_ = false;
  }

  // Sanity-check the configured runtime style.
  CHECK_EQ(is_alloy_style_ ? CEF_RUNTIME_STYLE_ALLOY : CEF_RUNTIME_STYLE_CHROME,
           browser->GetHost()->GetRuntimeStyle());

  // Add to the list of existing browsers.
  browser_list_.push_back(browser);

  if (browser->IsPopup()) {
    FinishPendingPopup(browser->GetHost()->GetOpenerIdentifier());
  }

  // A popup may finish creation after root shutdown has already begun. Track
  // it as unmanaged and close it through the normal beforeunload path so the
  // root cannot outlive a newly-created extension or page popup.
  if (shell_closing_ && unmanaged_close_requests_
                            .insert(browser->GetIdentifier())
                            .second) {
    CefPostTask(TID_UI,
                base::BindOnce(
                    [](CefRefPtr<CefBrowser> retained_browser) {
                      retained_browser->GetHost()->CloseBrowser(false);
                    },
                    browser));
  }
}

bool SimpleHandler::DoClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();

  // Closing the main window requires special handling. See the DoClose()
  // documentation in the CEF header for a detailed destription of this
  // process.
  if (browser_list_.size() == 1) {
    // Set a flag to indicate that the window close should be allowed.
    is_closing_ = true;
  }

  // Allow the close. For windowed browsers this will result in the OS close
  // event being sent.
  return false;
}

void SimpleHandler::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();

  // Release any AppKit sheet and retained CEF callback even if Chromium did
  // not deliver OnResetDialogState before final browser teardown.
  CancelNativeBeforeUnloadDialog(browser);

  // CEF may destroy an opener before reporting aborts for its pending popup
  // creations. Those creations cannot subsequently become live browsers.
  const int browser_id = browser->GetIdentifier();
  auto pending_it = pending_popups_by_opener_.find(browser_id);
  if (pending_it != pending_popups_by_opener_.end()) {
    pending_popup_count_ -= pending_it->second;
    pending_popups_by_opener_.erase(pending_it);
  }

  // Remove from the list of existing browsers.
  BrowserList::iterator bit = browser_list_.begin();
  for (; bit != browser_list_.end(); ++bit) {
    if ((*bit)->IsSame(browser)) {
      browser_list_.erase(bit);
      break;
    }
  }

  unmanaged_close_requests_.erase(browser_id);
  audio_streams_.erase(browser_id);
  active_downloads_.erase(browser_id);

  MaybeFinishShellClose();
}

void SimpleHandler::OnAudioStreamStarted(CefRefPtr<CefBrowser> browser,
                                         const CefAudioParameters&, int) {
  // CEF invokes this on an audio capture thread. Retain both CEF objects until
  // the state mutation has reached the UI thread.
  CefRefPtr<SimpleHandler> self(this);
  CefPostTask(TID_UI, base::BindOnce(
      [](CefRefPtr<SimpleHandler> handler, CefRefPtr<CefBrowser> retained_browser) {
        CEF_REQUIRE_UI_THREAD();
        const int browser_id = retained_browser->GetIdentifier();
        const size_t prior = handler->audio_streams_[browser_id]++;
        if (prior == 0 && handler->page_manager_)
          handler->page_manager_->NotifyAudioChanged(retained_browser, true);
      },
      self, browser));
}

void SimpleHandler::OnAudioStreamStopped(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  const int browser_id = browser->GetIdentifier();
  auto it = audio_streams_.find(browser_id);
  if (it == audio_streams_.end()) return;
  DCHECK_GT(it->second, 0U);
  if (--it->second != 0) return;
  audio_streams_.erase(it);
  if (page_manager_) page_manager_->NotifyAudioChanged(browser, false);
}

void SimpleHandler::OnAudioStreamError(CefRefPtr<CefBrowser>, const CefString&) {
  // CEF guarantees OnAudioStreamStopped after an error. Keep the existing
  // protection until that definitive UI-thread transition arrives.
}

void SimpleHandler::OnDownloadUpdated(CefRefPtr<CefBrowser> browser,
                                      CefRefPtr<CefDownloadItem> item,
                                      CefRefPtr<CefDownloadItemCallback>) {
  CEF_REQUIRE_UI_THREAD();
  if (!item || !item->IsValid()) return;
  const int browser_id = browser->GetIdentifier();
  auto& downloads = active_downloads_[browser_id];
  const bool was_active = !downloads.empty();
  if (item->IsInProgress()) downloads.insert(item->GetId());
  else downloads.erase(item->GetId());
  const bool is_active = !downloads.empty();
  if (!is_active) active_downloads_.erase(browser_id);
  if (was_active != is_active && page_manager_)
    page_manager_->NotifyDownloadChanged(browser, is_active);
}

bool SimpleHandler::OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                                  const CefKeyEvent& event, CefEventHandle,
                                  bool*) {
  CEF_REQUIRE_UI_THREAD();
  if (IsEditableMutation(event) && page_manager_)
    page_manager_->NotifyContentEdited(browser);
  return false;
}

bool SimpleHandler::OnBeforeUnloadDialog(
    CefRefPtr<CefBrowser> browser,
    const CefString& message_text,
    bool is_reload,
    CefRefPtr<CefJSDialogCallback> callback) {
  CEF_REQUIRE_UI_THREAD();
  CefRefPtr<SimpleHandler> self(this);
  return ShowNativeBeforeUnloadDialog(
      browser, shell_ ? shell_->GetWindowHandle() : nullptr, message_text,
      callback,
      [self, browser](bool leave_page) {
        CEF_REQUIRE_UI_THREAD();
        if (leave_page) {
          return;
        }

        const bool was_shell_closing = self->shell_closing_;
        if (was_shell_closing) {
          self->SetShellClosing(false);
        }
        const bool managed_page_recovered =
            self->page_manager_ &&
            self->page_manager_->AcknowledgeCloseCancelled(browser);
        if (was_shell_closing && !managed_page_recovered &&
            self->shell_close_cancelled_callback_) {
          self->shell_close_cancelled_callback_();
        }
      });
}

void SimpleHandler::OnResetDialogState(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  CancelNativeBeforeUnloadDialog(browser);
}

void SimpleHandler::OnLoadError(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                ErrorCode errorCode,
                                const CefString& errorText,
                                const CefString& failedUrl) {
  CEF_REQUIRE_UI_THREAD();

  // Allow Chrome to show the error page.
  if (!is_alloy_style_) {
    return;
  }

  // Don't display an error for downloaded files.
  if (errorCode == ERR_ABORTED) {
    return;
  }

  // Display a load error message using a data: URI.
  std::stringstream ss;
  ss << "<html><body bgcolor=\"white\">"
        "<h2>Failed to load URL "
     << std::string(failedUrl) << " with error " << std::string(errorText)
     << " (" << errorCode << ").</h2></body></html>";

  frame->LoadURL(GetDataURI(ss.str(), "text/html"));
}

void SimpleHandler::SetShell(
    CefWindow* shell,
    PageManager* manager,
    ShellCloseCancelledCallback close_cancelled_callback) {
  CEF_REQUIRE_UI_THREAD();
  shell_ = shell;
  page_manager_ = manager;
  shell_close_cancelled_callback_ = std::move(close_cancelled_callback);
  if (!shell_) {
    shell_closing_ = false;
    unmanaged_close_requests_.clear();
  }
}

void SimpleHandler::OnShellDestroyed() {
  CEF_REQUIRE_UI_THREAD();
  shell_ = nullptr;
  page_manager_ = nullptr;
  shell_close_cancelled_callback_ = {};
  shell_closing_ = true;

  std::vector<CefRefPtr<CefBrowser>> browsers(browser_list_.begin(),
                                              browser_list_.end());
  for (const auto& browser : browsers) {
    browser->GetHost()->CloseBrowser(false);
  }
  MaybeFinishShellClose();
}

void SimpleHandler::SetShellClosing(bool closing) {
  CEF_REQUIRE_UI_THREAD();
  shell_closing_ = closing;
  if (!closing) {
    is_closing_ = false;
    unmanaged_close_requests_.clear();
  }
}

bool SimpleHandler::CanCloseShell() {
  CEF_REQUIRE_UI_THREAD();
  shell_closing_ = true;

  std::vector<CefRefPtr<CefBrowser>> unmanaged_browsers;
  for (const auto& browser : browser_list_) {
    const int browser_id = browser->GetIdentifier();
    if (page_manager_ && page_manager_->PageIdForBrowser(browser)) {
      continue;
    }
    if (unmanaged_close_requests_.insert(browser_id).second) {
      unmanaged_browsers.push_back(browser);
    }
  }

  for (const auto& browser : unmanaged_browsers) {
    browser->GetHost()->CloseBrowser(false);
  }
  return browser_list_.empty() && pending_popup_count_ == 0;
}

void SimpleHandler::FinishPendingPopup(int opener_browser_id) {
  CEF_REQUIRE_UI_THREAD();
  auto it = pending_popups_by_opener_.find(opener_browser_id);
  if (it == pending_popups_by_opener_.end()) {
    return;
  }
  DCHECK_GT(it->second, 0U);
  DCHECK_GT(pending_popup_count_, 0U);
  --it->second;
  --pending_popup_count_;
  if (it->second == 0) {
    pending_popups_by_opener_.erase(it);
  }
  MaybeFinishShellClose();
}

void SimpleHandler::MaybeFinishShellClose() {
  CEF_REQUIRE_UI_THREAD();
  if (!shell_closing_ || !browser_list_.empty() || pending_popup_count_ != 0) {
    return;
  }

  if (!shell_) {
    CefQuitMessageLoop();
    return;
  }
  if (shell_close_retry_posted_) {
    return;
  }

  shell_close_retry_posted_ = true;
  CefRefPtr<SimpleHandler> self(this);
  CefPostTask(TID_UI, base::BindOnce([](CefRefPtr<SimpleHandler> retained_self) {
                retained_self->shell_close_retry_posted_ = false;
                if (retained_self->shell_ && retained_self->shell_closing_) {
                  retained_self->shell_->Close();
                }
              }, self));
}

void SimpleHandler::ShowMainWindow() {
  if (!CefCurrentlyOn(TID_UI)) {
    // Execute on the UI thread.
    CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::ShowMainWindow, this));
    return;
  }

  if (shell_) { shell_->Show(); shell_->Activate(); return; }
  if (browser_list_.empty()) {
    return;
  }

  auto main_browser = browser_list_.front();

  if (auto browser_view = CefBrowserView::GetForBrowser(main_browser)) {
    // Show the window using the Views framework.
    if (auto window = browser_view->GetWindow()) {
      window->Show();
    }
  } else if (is_alloy_style_) {
    PlatformShowWindow(main_browser);
  }
}

void SimpleHandler::CloseAllBrowsers(bool force_close) {
  if (!CefCurrentlyOn(TID_UI)) {
    // Execute on the UI thread.
    CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::CloseAllBrowsers, this,
                                       force_close));
    return;
  }

  if (shell_) { shell_->Close(); return; }
  if (browser_list_.empty()) {
    return;
  }

  BrowserList::const_iterator it = browser_list_.begin();
  for (; it != browser_list_.end(); ++it) {
    (*it)->GetHost()->CloseBrowser(force_close);
  }
}

#if !defined(OS_MAC)
void SimpleHandler::PlatformShowWindow(CefRefPtr<CefBrowser> browser) {
  NOTIMPLEMENTED();
}
#endif
