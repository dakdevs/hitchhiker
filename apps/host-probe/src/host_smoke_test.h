#ifndef HITCHHIKER_HOST_PROBE_HOST_SMOKE_TEST_H_
#define HITCHHIKER_HOST_PROBE_HOST_SMOKE_TEST_H_
#pragma once

#include <functional>
#include <string>

#include "include/cef_base.h"

class CefWindow;
class PageManager;

// Runs entirely through each embedded browser's in-process DevTools agent. The
// caller must invoke this on the CEF UI thread after pages "one" and "two"
// have completed loading. |completion| is called exactly once on the UI thread.
void RunHostSmokeTest(CefRefPtr<PageManager> page_manager,
                      CefRefPtr<CefWindow> root_window,
                      std::function<void(bool, std::string)> completion);

#endif  // HITCHHIKER_HOST_PROBE_HOST_SMOKE_TEST_H_
