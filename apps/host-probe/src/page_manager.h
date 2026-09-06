// Copyright (c) 2013 The Chromium Embedded Framework Authors. All rights
// reserved. Use of this source code is governed by a BSD-style license that
// can be found in the LICENSE file.

#ifndef HITCHHIKER_HOST_PROBE_PAGE_MANAGER_H_
#define HITCHHIKER_HOST_PROBE_PAGE_MANAGER_H_
#pragma once

#include <cstddef>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/views/cef_window.h"

struct PageViewport {
  std::string page_id;
  // Bounds relative to the root window's client area, in DIP.
  CefRect bounds;
};

struct PageEvent {
  enum Type {
    kCreated,
    kClosed,
    kCloseCancelled,
    kTitleChanged,
    kNavigationChanged,
    // Native, page-scoped activity signals. These are advisory protection
    // inputs for the trusted runtime; they never cause a page to be closed.
    kResourcesChanged,
  };

  Type type;
  std::string page_id;
  CefRefPtr<CefBrowser> browser;
  CefString title;
  bool audio = false;
  bool call = false;
  bool download = false;
  bool unsaved_input = false;
  // Valid for kClosed. A value of zero means that all requested page windows
  // and browsers have finished tearing down.
  size_t remaining_pages = 0;
};

enum class PageCloseResult {
  kNotFound,
  kRequested,
  kAlreadyRequested,
};

class PageManagerCore;

// Owns the Chromium page surfaces associated with one Native root window.
// All methods must be called on the CEF browser-process UI thread.
class PageManager : public CefBaseRefCounted {
 public:
  using EventCallback = std::function<void(const PageEvent&)>;

  static CefRefPtr<PageManager> Create(CefRefPtr<CefWindow> root_window,
                                       CefRefPtr<CefClient> shared_client,
                                       EventCallback event_callback = {});

  // Accepts creation of a new page. Browser creation completes asynchronously
  // and is reported with PageEvent::Type::kCreated.
  bool Open(const std::string& page_id, const CefString& url);

  // Requests a close while preserving beforeunload behavior.
  PageCloseResult Close(const std::string& page_id);

  // Requests closure of every page and returns the number of page records that
  // are still draining after the requests have been issued.
  size_t CloseAll();

  // Ends the global close batch after an unmanaged popup rejects shell close.
  // Page records already closing continue to drain normally.
  void CancelCloseAll();

  // Recover a page after the host's custom beforeunload UI reports that the
  // user canceled closing. Returns false if the browser is unknown, was not
  // closing, or has already entered CEF's mandatory close state.
  bool AcknowledgeCloseCancelled(CefRefPtr<CefBrowser> browser);

  // Atomically replaces the visible viewport bindings. Omitted pages are
  // hidden. Returns false without changing the current bindings if an ID is
  // unknown, duplicated, closing, has invalid bounds, or overlaps another
  // viewport.
  bool SetViewports(const std::vector<PageViewport>& viewports);

  // Repositions visible page windows using the cached root-relative viewport
  // bindings and the root window's current screen position.
  void Layout();

  CefRefPtr<CefBrowser> BrowserForPage(const std::string& page_id) const;
  std::optional<std::string> PageIdForBrowser(
      CefRefPtr<CefBrowser> browser) const;

  // The shared CefDisplayHandler should forward title changes here.
  void NotifyTitleChanged(CefRefPtr<CefBrowser> browser,
                          const CefString& title);
  void NotifyNavigationChanged(CefRefPtr<CefBrowser> browser);
  void NotifyAudioChanged(CefRefPtr<CefBrowser> browser, bool active);
  void NotifyCallChanged(CefRefPtr<CefBrowser> browser, bool active);
  void NotifyDownloadChanged(CefRefPtr<CefBrowser> browser, bool active);
  // This is deliberately conservative: keyboard edits protect a page until
  // its main frame navigates. It does not claim to know application save state.
  void NotifyContentEdited(CefRefPtr<CefBrowser> browser);

  bool empty() const;
  bool closing_all() const;

 private:
  PageManager(CefRefPtr<CefWindow> root_window,
              CefRefPtr<CefClient> shared_client,
              EventCallback event_callback);
  ~PageManager() override;

  std::shared_ptr<PageManagerCore> core_;

  IMPLEMENT_REFCOUNTING(PageManager);
  DISALLOW_COPY_AND_ASSIGN(PageManager);
};

#endif  // HITCHHIKER_HOST_PROBE_PAGE_MANAGER_H_
