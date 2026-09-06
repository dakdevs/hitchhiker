// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights
// reserved. Use of this source code is governed by a BSD-style license that
// can be found in the LICENSE file.

#include "src/simple_app.h"
#include "src/native_sidebar.h"
#include "src/host_smoke_test.h"
#include "include/cef_command_line.h"
#include "src/page_manager.h"
#include "src/simple_handler.h"
#include "include/cef_app.h"
#include "include/base/cef_callback.h"
#include "include/views/cef_window.h"
#include "include/views/cef_window_delegate.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_closure_task.h"
#include <algorithm>
#include <cstdio>

namespace {
int smoke_exit_code = 0;
class ShellWindowDelegate : public CefWindowDelegate {
 public:
  explicit ShellWindowDelegate(CefRefPtr<SimpleHandler> handler) : handler_(handler) {}

  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    root_ = window;
    self_test_ = CefCommandLine::GetGlobalCommandLine()->HasSwitch("self-test");
    if (self_test_) smoke_exit_code = 1;
    window->SetTitle("Hitchhiker");
    manager_ = PageManager::Create(window, handler_, [this](const PageEvent& event) {
      OnPageEvent(event);
    });
    handler_->SetShell(window.get(), manager_.get(), [this] { CancelClosing(); });
    sidebar_ = InstallNativeSidebar(window, [this](NativeCommand command) {
      if (closing_) return;
      presentation_ = command;
      ApplyLayout();
    });
    if (!sidebar_) {
      fprintf(stderr, "HITCHHIKER_NATIVE_MOUNT_FAILED\n");
      window->Close();
      return;
    }
    window->Show();
    if (!manager_->Open("one", "http://127.0.0.1:4319/one") ||
        !manager_->Open("two", "http://127.0.0.1:4319/two")) {
      fprintf(stderr, "HITCHHIKER_PAGE_CREATION_FAILED\n");
      window->Close();
      return;
    }
    ApplyLayout();
  }

  void OnPageEvent(const PageEvent& event) {
    if (event.type == PageEvent::kCreated) {
      fprintf(stderr, "HITCHHIKER_PAGE_CREATED %s\n", event.page_id.c_str());
      ApplyLayout();
    } else if (event.type == PageEvent::kTitleChanged) {
      if (event.page_id == "one" && event.title == "Hitchhiker fixture one") {
        one_ready_ = true;
        NotifyNativeState(sidebar_, "one.ready");
      }
      if (event.page_id == "two" && event.title == "Hitchhiker fixture two") {
        two_ready_ = true;
        NotifyNativeState(sidebar_, "two.ready");
      }
      if (self_test_ && one_ready_ && two_ready_ && !test_started_) {
        test_started_ = true;
        CefPostTask(TID_UI, base::BindOnce([](CefRefPtr<PageManager> manager, CefRefPtr<CefWindow> root) {
          RunHostSmokeTest(manager, root, [root](bool passed, std::string report) {
            smoke_exit_code = passed ? 0 : 1;
            fprintf(stderr, "HITCHHIKER_SMOKE_%s %s\n", passed ? "PASS" : "FAIL", report.c_str());
            if (!root->IsClosed()) root->Close();
          });
        }, manager_, root_));
      }
      fprintf(stderr, "HITCHHIKER_PAGE_TITLE %s\n", event.page_id.c_str());
    } else if (event.type == PageEvent::kCloseCancelled) {
      CancelClosing();
    } else if (event.type == PageEvent::kClosed) {
      fprintf(stderr, "HITCHHIKER_PAGE_CLOSED %s remaining=%zu\n", event.page_id.c_str(), event.remaining_pages);
      if (!closing_) ApplyLayout();
      if (closing_ && event.remaining_pages == 0 && root_) {
        CefPostTask(TID_UI, base::BindOnce([](CefRefPtr<CefWindow> root) {
          if (!root->IsClosed()) root->Close();
        }, root_));
      }
    }
  }

  void CancelClosing() {
    closing_ = false;
    if (manager_) manager_->CancelCloseAll();
    handler_->SetShellClosing(false);
    ApplyLayout();
  }

  void ApplyLayout() {
    if (!root_ || !manager_ || closing_) return;
    const CefRect client = root_->GetClientAreaBoundsInScreen();
    ResizeNativeSidebar(sidebar_, client.height);
    const int width = std::max(2, client.width - 260);
    const int height = std::max(1, client.height);
    const bool have_one = !!manager_->BrowserForPage("one");
    const bool have_two = !!manager_->BrowserForPage("two");
    if (!have_one && have_two) presentation_ = NativeCommand::kShowTwo;
    if (!have_two && have_one) presentation_ = NativeCommand::kShowOne;
    std::vector<PageViewport> viewports;
    if (!have_one && !have_two) {
      manager_->SetViewports({});
      return;
    }
    if (presentation_ == NativeCommand::kSplit) {
      viewports = {{"one", CefRect(260, 0, width / 2, height)},
                   {"two", CefRect(260 + width / 2, 0, width - width / 2, height)}};
    } else {
      viewports = {{presentation_ == NativeCommand::kShowOne ? "one" : "two", CefRect(260, 0, width, height)}};
    }
    if (manager_->SetViewports(viewports)) {
      const char* state = presentation_ == NativeCommand::kSplit ? "layout.split" :
                          presentation_ == NativeCommand::kShowOne ? "layout.one" : "layout.two";
      NotifyNativeState(sidebar_, state);
      fprintf(stderr, "HITCHHIKER_VIEWPORTS %s\n", state);
    }
  }

  void OnWindowBoundsChanged(CefRefPtr<CefWindow>, const CefRect&) override { ApplyLayout(); }
  void OnWindowFullscreenTransition(CefRefPtr<CefWindow>, bool complete) override {
    if (complete) ApplyLayout();
  }
  bool CanClose(CefRefPtr<CefWindow>) override {
    closing_ = true;
    const bool clients_drained = handler_->CanCloseShell();
    const bool pages_drained = !manager_ || manager_->CloseAll() == 0;
    return clients_drained && pages_drained;
  }
  void OnWindowDestroyed(CefRefPtr<CefWindow>) override {
    DestroyNativeSidebar(sidebar_);
    sidebar_ = nullptr;
    handler_->OnShellDestroyed();
    manager_ = nullptr;
    root_ = nullptr;
    fprintf(stderr, "HITCHHIKER_SHELL_CLOSED\n");
  }
  CefSize GetPreferredSize(CefRefPtr<CefView>) override { return CefSize(1100, 720); }
  CefSize GetMinimumSize(CefRefPtr<CefView>) override { return CefSize(760, 480); }
  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }
 private:
  CefRefPtr<SimpleHandler> handler_;
  CefRefPtr<CefWindow> root_;
  CefRefPtr<PageManager> manager_;
  void* sidebar_ = nullptr;
  NativeCommand presentation_ = NativeCommand::kShowOne;
  bool closing_ = false;
  bool self_test_ = false;
  bool one_ready_ = false;
  bool two_ready_ = false;
  bool test_started_ = false;
  IMPLEMENT_REFCOUNTING(ShellWindowDelegate);
};
}
int HostSmokeTestExitCode() { return smoke_exit_code; }
SimpleApp::SimpleApp() = default;
void SimpleApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  CefRefPtr<SimpleHandler> handler(new SimpleHandler(false));
  CefWindow::CreateTopLevelWindow(new ShellWindowDelegate(handler));
}
CefRefPtr<CefClient> SimpleApp::GetDefaultClient() { return SimpleHandler::GetInstance(); }
