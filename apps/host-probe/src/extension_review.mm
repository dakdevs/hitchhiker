#import <Cocoa/Cocoa.h>
#include "src/extension_review.h"
#include "include/wrapper/cef_helpers.h"
#include <utility>

namespace {
// Package strings are data. Escape control and bidi characters instead of letting
// them impersonate the prompt's trusted labels or reverse an artifact identity.
NSString* Display(const std::string& text) {
  NSString* source = [[NSString alloc] initWithBytes:text.data()
                                            length:text.size()
                                          encoding:NSUTF8StringEncoding];
  NSMutableString* result = [NSMutableString string];
  for (NSUInteger index = 0; index < source.length; ++index) {
    unichar unit = [source characterAtIndex:index];
    if ([[NSCharacterSet controlCharacterSet] characterIsMember:unit] || unit == 0x00ad ||
        unit == 0x034f || unit == 0x061c || (unit >= 0x200b && unit <= 0x200f) ||
        (unit >= 0x2028 && unit <= 0x202e) || (unit >= 0x2060 && unit <= 0x206f) ||
        unit == 0xfeff || (unit >= 0xfff9 && unit <= 0xfffb)) {
      [result appendFormat:@"\\u%04x", unit];
    } else {
      [result appendFormat:@"%C", unit];
    }
  }
  return result;
}

void AddGroup(NSMutableArray<NSString*>* rows, NSString* heading,
              const std::vector<std::string>& values) {
  [rows addObject:heading];
  if (values.empty()) [rows addObject:@"  None declared"];
  for (const auto& value : values) [rows addObject:[@"  " stringByAppendingString:Display(value)]];
}
}  // namespace

@interface HHExtensionReviewPrompt : NSObject {
 @private
  NSAlert* alert_;
  NSTextView* permissions_;
  NSScrollView* scroll_;
  NSTextField* page_label_;
  NSButton* previous_;
  NSButton* next_;
  NSArray<NSString*>* rows_;
  NSUInteger page_;
  NSMutableIndexSet* seen_pages_;
  BOOL rendering_;
  BOOL finished_;
  std::function<void(bool)> decision_;
}
- (instancetype)initWithMetadata:(const ExtensionReviewMetadata&)metadata
                       decision:(std::function<void(bool)>)decision;
- (void)begin:(NSWindow*)window;
- (void)cancel;
- (BOOL)active;
@end

@implementation HHExtensionReviewPrompt
- (instancetype)initWithMetadata:(const ExtensionReviewMetadata&)metadata
                       decision:(std::function<void(bool)>)decision {
  self = [super init];
  if (!self) return nil;
  decision_ = std::move(decision);
  alert_ = [[NSAlert alloc] init];
  alert_.messageText = @"Install Chrome extension?";
  alert_.informativeText = @"Review the requesting principal, exact extension identity, and every page of declared permissions and site access. Scroll to the bottom of each page to continue.";
  alert_.alertStyle = NSAlertStyleWarning;
  [alert_ addButtonWithTitle:@"Cancel"];
  [alert_ addButtonWithTitle:@"Install extension"];
  // Return cancels; approval always requires selecting the explicit install button.
  alert_.buttons[0].keyEquivalent = @"\r";
  alert_.buttons[1].keyEquivalent = @"";
  NSMutableArray<NSString*>* rows = [NSMutableArray array];
  [rows addObject:[@"Requested by: " stringByAppendingString:Display(metadata.requester)]];
  [rows addObject:[@"Profile: " stringByAppendingString:Display(metadata.profile_id)]];
  [rows addObject:[@"Extension: " stringByAppendingString:Display(metadata.name)]];
  [rows addObject:[@"Version: " stringByAppendingString:Display(metadata.version)]];
  [rows addObject:[@"Chromium ID: " stringByAppendingString:Display(metadata.chromium_id)]];
  [rows addObject:[@"Installation: " stringByAppendingString:Display(metadata.installation_id)]];
  [rows addObject:[@"SHA-256: " stringByAppendingString:Display(metadata.digest)]];
  AddGroup(rows, @"Required permissions", metadata.permissions);
  AddGroup(rows, @"Required site access", metadata.host_permissions);
  AddGroup(rows, @"Optional permissions", metadata.optional_permissions);
  AddGroup(rows, @"Optional site access", metadata.optional_host_permissions);
  rows_ = [rows copy];
  seen_pages_ = [NSMutableIndexSet indexSet];
  NSView* accessory = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 540, 310)];
  NSScrollView* scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 42, 540, 268)];
  scroll.hasVerticalScroller = YES;
  scroll.borderType = NSBezelBorder;
  permissions_ = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 520, 268)];
  permissions_.editable = NO;
  permissions_.selectable = YES;
  permissions_.richText = NO;
  permissions_.font = [NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightRegular];
  permissions_.textContainer.widthTracksTextView = YES;
  permissions_.verticallyResizable = YES;
  permissions_.autoresizingMask = NSViewWidthSizable;
  scroll.documentView = permissions_;
  scroll_ = scroll;
  scroll.contentView.postsBoundsChangedNotifications = YES;
  [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(didScroll:)
      name:NSViewBoundsDidChangeNotification object:scroll.contentView];
  [accessory addSubview:scroll];
  previous_ = [NSButton buttonWithTitle:@"Previous" target:self action:@selector(previous:)];
  previous_.frame = NSMakeRect(0, 4, 100, 30);
  [accessory addSubview:previous_];
  next_ = [NSButton buttonWithTitle:@"Next" target:self action:@selector(next:)];
  next_.frame = NSMakeRect(440, 4, 100, 30);
  [accessory addSubview:next_];
  page_label_ = [NSTextField labelWithString:@""];
  page_label_.frame = NSMakeRect(110, 8, 320, 24);
  page_label_.alignment = NSTextAlignmentCenter;
  [accessory addSubview:page_label_];
  alert_.accessoryView = accessory;
  [self renderPage];
  return self;
}
- (NSUInteger)pageCount { return (rows_.count + 19) / 20; }
- (void)dealloc { [[NSNotificationCenter defaultCenter] removeObserver:self]; }
- (void)didScroll:(NSNotification*)notification {
  if (!rendering_ && !finished_) [self updateGates];
}
- (void)updateGates {
  [permissions_.layoutManager ensureLayoutForTextContainer:permissions_.textContainer];
  NSRect used = [permissions_.layoutManager usedRectForTextContainer:permissions_.textContainer];
  NSRect visible = scroll_.contentView.documentVisibleRect;
  if (NSMaxY(visible) + 0.5 >= NSMaxY(used) + permissions_.textContainerInset.height)
    [seen_pages_ addIndex:page_];
  previous_.enabled = page_ > 0;
  next_.enabled = [seen_pages_ containsIndex:page_] && page_ + 1 < [self pageCount];
  alert_.buttons[1].enabled = seen_pages_.count == [self pageCount];
}
- (void)renderPage {
  rendering_ = YES;
  const NSUInteger start = page_ * 20;
  const NSUInteger count = MIN((NSUInteger)20, rows_.count - start);
  permissions_.string = [[rows_ subarrayWithRange:NSMakeRange(start, count)] componentsJoinedByString:@"\n"];
  [permissions_ setFrameSize:NSMakeSize(scroll_.contentSize.width, scroll_.contentSize.height)];
  [permissions_.layoutManager ensureLayoutForTextContainer:permissions_.textContainer];
  NSRect used = [permissions_.layoutManager usedRectForTextContainer:permissions_.textContainer];
  [permissions_ setFrameSize:NSMakeSize(scroll_.contentSize.width,
      MAX(scroll_.contentSize.height, NSMaxY(used) + 2 * permissions_.textContainerInset.height))];
  [permissions_ scrollRangeToVisible:NSMakeRange(0, 0)];
  page_label_.stringValue = [NSString stringWithFormat:@"Permission page %lu of %lu",
      (unsigned long)(page_ + 1), (unsigned long)[self pageCount]];
  rendering_ = NO;
  [self updateGates];
}
- (void)previous:(id)sender {
  if (page_ > 0 && !finished_) { --page_; [self renderPage]; }
}
- (void)next:(id)sender {
  if ([seen_pages_ containsIndex:page_] && page_ + 1 < [self pageCount] && !finished_) {
    ++page_;
    [self renderPage];
  }
}
- (void)finish:(BOOL)approved {
  if (finished_) return;
  finished_ = YES;
  auto decision = std::move(decision_);
  if (decision) decision(approved && seen_pages_.count == [self pageCount]);
}
- (void)begin:(NSWindow*)window {
  __weak HHExtensionReviewPrompt* weakSelf = self;
  [alert_ beginSheetModalForWindow:window completionHandler:^(NSModalResponse response) {
    HHExtensionReviewPrompt* prompt = weakSelf;
    if (prompt) [prompt finish:response == NSAlertSecondButtonReturn];
  }];
}
- (BOOL)active { return !finished_; }
- (void)cancel {
  if (finished_) return;
  NSWindow* sheet = alert_.window;
  if (sheet.sheetParent) [sheet.sheetParent endSheet:sheet returnCode:NSAlertFirstButtonReturn];
  [self finish:NO];
}
@end

struct NativeExtensionReview::Impl {
  HHExtensionReviewPrompt* prompt;
};
NativeExtensionReview::NativeExtensionReview(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
NativeExtensionReview::~NativeExtensionReview() { Cancel(); }
bool NativeExtensionReview::active() const {
  CEF_REQUIRE_UI_THREAD();
  return [impl_->prompt active];
}
void NativeExtensionReview::Cancel() {
  CEF_REQUIRE_UI_THREAD();
  [impl_->prompt cancel];
}
std::unique_ptr<NativeExtensionReview> NativeExtensionReview::Show(
    CefWindowHandle parent, const ExtensionReviewMetadata& metadata,
    std::function<void(bool)> decision) {
  CEF_REQUIRE_UI_THREAD();
  if (!parent || !decision) return nullptr;
  NSWindow* window = ((__bridge NSView*)parent).window;
  if (!window || window.attachedSheet) return nullptr;
  auto impl = std::make_unique<Impl>();
  impl->prompt = [[HHExtensionReviewPrompt alloc] initWithMetadata:metadata decision:std::move(decision)];
  [impl->prompt begin:window];
  return std::unique_ptr<NativeExtensionReview>(new NativeExtensionReview(std::move(impl)));
}
