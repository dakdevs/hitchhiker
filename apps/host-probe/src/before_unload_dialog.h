#ifndef HITCHHIKER_HOST_PROBE_BEFORE_UNLOAD_DIALOG_H_
#define HITCHHIKER_HOST_PROBE_BEFORE_UNLOAD_DIALOG_H_
#pragma once

#include <functional>

#include "include/cef_browser.h"
#include "include/cef_jsdialog_handler.h"

using BeforeUnloadDecisionCallback = std::function<void(bool leave_page)>;

// Shows an asynchronous AppKit sheet attached to the browser's CEF-owned
// NSWindow. Returns false without consuming |callback| if no host window is
// available, allowing CEF to use its default dialog.
bool ShowNativeBeforeUnloadDialog(
    CefRefPtr<CefBrowser> browser,
    CefWindowHandle preferred_parent_handle,
    const CefString& message_text,
    CefRefPtr<CefJSDialogCallback> callback,
    BeforeUnloadDecisionCallback decision_callback);

// Resolves a currently displayed custom prompt as "Stay". Safe to call when
// no prompt exists for |browser|.
void CancelNativeBeforeUnloadDialog(CefRefPtr<CefBrowser> browser);

#endif  // HITCHHIKER_HOST_PROBE_BEFORE_UNLOAD_DIALOG_H_
