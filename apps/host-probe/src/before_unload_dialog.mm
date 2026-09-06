#import <Cocoa/Cocoa.h>

#include "src/before_unload_dialog.h"

#include <utility>

#include "include/wrapper/cef_helpers.h"

@interface HHBeforeUnloadPrompt : NSObject {
 @private
  int browser_id_;
  CefRefPtr<CefJSDialogCallback> callback_;
  BeforeUnloadDecisionCallback decision_callback_;
  NSAlert* alert_;
  BOOL finished_;
}
- (instancetype)initWithBrowserId:(int)browserId
                          message:(NSString*)message
                         callback:(CefRefPtr<CefJSDialogCallback>)callback
                 decisionCallback:(BeforeUnloadDecisionCallback)decisionCallback;
- (void)beginForWindow:(NSWindow*)window;
- (void)cancel;
@end

namespace {

NSMutableDictionary<NSNumber*, HHBeforeUnloadPrompt*>* g_prompts;

}  // namespace

@implementation HHBeforeUnloadPrompt

- (instancetype)initWithBrowserId:(int)browserId
                          message:(NSString*)message
                         callback:(CefRefPtr<CefJSDialogCallback>)callback
                 decisionCallback:(BeforeUnloadDecisionCallback)decisionCallback {
  self = [super init];
  if (self) {
    browser_id_ = browserId;
    callback_ = callback;
    decision_callback_ = std::move(decisionCallback);
    alert_ = [[NSAlert alloc] init];
    alert_.messageText = @"Leave this page?";
    alert_.informativeText = message.length > 0
                                 ? message
                                 : @"Changes you made may not be saved.";
    alert_.alertStyle = NSAlertStyleWarning;
    [alert_ addButtonWithTitle:@"Leave"];
    [alert_ addButtonWithTitle:@"Stay"];
  }
  return self;
}

- (void)finishWithLeaveDecision:(BOOL)leave {
  if (finished_) {
    return;
  }
  finished_ = YES;

  // Keep the receiver alive while removal releases the dictionary's strong
  // reference. Remove first because Continue() can synchronously reset dialog
  // state through CEF.
  HHBeforeUnloadPrompt* keepAlive = self;
  NSNumber* key = @(browser_id_);
  if (g_prompts[key] == self) {
    [g_prompts removeObjectForKey:key];
  }

  CefRefPtr<CefJSDialogCallback> callback = callback_;
  callback_ = nullptr;
  BeforeUnloadDecisionCallback decision_callback =
      std::move(decision_callback_);

  callback->Continue(leave, CefString());
  if (decision_callback) {
    decision_callback(leave);
  }
  (void)keepAlive;
}

- (void)beginForWindow:(NSWindow*)window {
  __weak HHBeforeUnloadPrompt* weakSelf = self;
  [alert_ beginSheetModalForWindow:window
                 completionHandler:^(NSModalResponse response) {
                   HHBeforeUnloadPrompt* prompt = weakSelf;
                   if (prompt) {
                     [prompt finishWithLeaveDecision:
                                 response == NSAlertFirstButtonReturn];
                   }
                 }];
}

- (void)cancel {
  if (finished_) {
    return;
  }
  NSWindow* sheet = alert_.window;
  if (sheet.sheetParent) {
    [sheet.sheetParent endSheet:sheet returnCode:NSAlertSecondButtonReturn];
  }
  // Do not retain the CEF callback until AppKit finishes its dismissal
  // animation. The sheet completion will observe finished_ and do nothing.
  [self finishWithLeaveDecision:NO];
}

@end

namespace {

NSWindow* WindowForHandle(CefWindowHandle handle) {
  if (!handle) {
    return nil;
  }
  NSView* host_view = (__bridge NSView*)handle;
  return host_view.window;
}

NSWindow* WindowForBrowser(CefRefPtr<CefBrowser> browser) {
  if (!browser) {
    return nil;
  }
  return WindowForHandle(browser->GetHost()->GetWindowHandle());
}

}  // namespace

bool ShowNativeBeforeUnloadDialog(
    CefRefPtr<CefBrowser> browser,
    CefWindowHandle preferred_parent_handle,
    const CefString& message_text,
    CefRefPtr<CefJSDialogCallback> callback,
    BeforeUnloadDecisionCallback decision_callback) {
  CEF_REQUIRE_UI_THREAD();
  if (!browser || !callback) {
    return false;
  }

  NSWindow* window = WindowForHandle(preferred_parent_handle);
  if (!window) {
    window = WindowForBrowser(browser);
  }
  if (!window) {
    return false;
  }

  if (!g_prompts) {
    g_prompts = [NSMutableDictionary dictionary];
  }
  NSNumber* key = @(browser->GetIdentifier());
  if (HHBeforeUnloadPrompt* existing = g_prompts[key]) {
    [existing cancel];
  }

  NSString* message = [NSString
      stringWithUTF8String:message_text.ToString().c_str()];
  HHBeforeUnloadPrompt* prompt = [[HHBeforeUnloadPrompt alloc]
      initWithBrowserId:browser->GetIdentifier()
                message:message
               callback:callback
       decisionCallback:std::move(decision_callback)];
  g_prompts[key] = prompt;
  [prompt beginForWindow:window];
  return true;
}

void CancelNativeBeforeUnloadDialog(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  if (!browser || !g_prompts) {
    return;
  }
  [g_prompts[@(browser->GetIdentifier())] cancel];
}
