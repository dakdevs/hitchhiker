// Copyright (c) 2026 Hitchhiker contributors.
// SPDX-License-Identifier: BSD-3-Clause

#ifndef HITCHHIKER_HOST_PROBE_ENGINE_BRIDGE_H_
#define HITCHHIKER_HOST_PROBE_ENGINE_BRIDGE_H_
#pragma once

#include <memory>
#include <functional>
#include <string>

#include "include/cef_base.h"
#include "include/cef_values.h"

class CefWindow;
class PageManager;
struct PageEvent;

// A private, parent-owned JSON-lines control channel for the native host.
// All public methods are called on the CEF browser-process UI thread.
class EngineBridge : public CefBaseRefCounted {
 public:
  // The root validates and applies this command through its native UI ABI.
  using UiCommitHandler = std::function<bool(CefRefPtr<CefDictionaryValue>,
                                             std::string*)>;

  static CefRefPtr<EngineBridge> Create(CefRefPtr<PageManager> manager,
                                        CefRefPtr<CefWindow> root_window);

  // Starts the stdin reader and stdout writer. It is harmless to call once.
  void Start();
  // Stops I/O and releases all CEF references. Call before root destruction.
  void Stop();

  // Forward the PageManager event callback here from the root delegate.
  void OnPageEvent(const PageEvent& event);
  // Sends a host event. |params| must be a dictionary and is copied into JSON.
  void SendEvent(const std::string& name,
                 CefRefPtr<CefDictionaryValue> params);
  void SetUiCommitHandler(UiCommitHandler handler);

 private:
  class Core;
  EngineBridge(CefRefPtr<PageManager> manager, CefRefPtr<CefWindow> root_window);
  ~EngineBridge() override;

  std::shared_ptr<Core> core_;

  IMPLEMENT_REFCOUNTING(EngineBridge);
  DISALLOW_COPY_AND_ASSIGN(EngineBridge);
};

#endif  // HITCHHIKER_HOST_PROBE_ENGINE_BRIDGE_H_
