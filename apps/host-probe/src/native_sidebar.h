#pragma once
#include "include/views/cef_window.h"
#include "include/cef_browser.h"
void* InstallNativeSidebar(CefRefPtr<CefWindow> window, CefRefPtr<CefBrowser> browser);
void ResizeNativeSidebar(void* sidebar, int height);
void DestroyNativeSidebar(void* sidebar);
void NotifyNativeTitle(CefRefPtr<CefBrowser> browser);
