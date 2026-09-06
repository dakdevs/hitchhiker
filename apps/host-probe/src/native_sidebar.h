#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include "include/views/cef_window.h"
enum class NativeCommand { kShowOne = 1, kShowTwo = 2, kSplit = 3 };
using NativeCommandSink = std::function<void(NativeCommand)>;
using NativeEventSink = std::function<void(const std::string& json)>;
void* InstallNativeSidebar(CefRefPtr<CefWindow> window,
                           NativeCommandSink sink,
                           NativeEventSink event_sink = {},
                           std::function<void()> recovery = {});
void ResizeNativeSidebar(void* sidebar, int height);
void ResizeNativeSurface(void* sidebar, int width, int height);
bool CommitNativeTree(void* sidebar, const char* json, size_t length,
                      uint64_t revision);
void DestroyNativeSidebar(void* sidebar);
void NotifyNativeState(void* sidebar, const char* command);
