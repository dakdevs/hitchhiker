#pragma once
#include <functional>
#include "include/views/cef_window.h"
enum class NativeCommand { kShowOne = 1, kShowTwo = 2, kSplit = 3 };
using NativeCommandSink = std::function<void(NativeCommand)>;
void* InstallNativeSidebar(CefRefPtr<CefWindow> window, NativeCommandSink sink);
void ResizeNativeSidebar(void* sidebar, int height);
void DestroyNativeSidebar(void* sidebar);
void NotifyNativeState(void* sidebar, const char* command);
