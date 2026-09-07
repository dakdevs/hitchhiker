#import <Cocoa/Cocoa.h>
#include "src/extension_directory_picker.h"
#include "include/wrapper/cef_helpers.h"
#include <utility>

namespace {
NSString* DisplayIdentity(const std::string& text) {
  NSString* source = [[NSString alloc] initWithBytes:text.data() length:text.size()
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
}  // namespace

@interface HHExtensionDirectoryPrompt : NSObject {
 @private
  NSOpenPanel* panel_;
  BOOL finished_;
  std::function<void(std::optional<std::string>)> decision_;
}
- (instancetype)initWithRequester:(const std::string&)requester
                         profile:(const std::string&)profile
                        decision:(std::function<void(std::optional<std::string>)>)decision;
- (void)begin:(NSWindow*)window;
- (void)cancel;
- (BOOL)active;
@end

@implementation HHExtensionDirectoryPrompt
- (instancetype)initWithRequester:(const std::string&)requester
                         profile:(const std::string&)profile
                        decision:(std::function<void(std::optional<std::string>)>)decision {
  self = [super init];
  if (!self) return nil;
  decision_ = std::move(decision);
  panel_ = [NSOpenPanel openPanel];
  panel_.title = @"Choose Chrome extension folder";
  panel_.prompt = @"Choose folder";
  panel_.message = [NSString stringWithFormat:
      @"Requested by: %@\nProfile: %@\nChoose a folder containing manifest.json. Hitchhiker will validate a private copy, then ask you to review permissions before installation.",
      DisplayIdentity(requester), DisplayIdentity(profile)];
  panel_.canChooseFiles = NO;
  panel_.canChooseDirectories = YES;
  panel_.allowsMultipleSelection = NO;
  panel_.canCreateDirectories = NO;
  panel_.resolvesAliases = NO;
  panel_.treatsFilePackagesAsDirectories = YES;
  return self;
}
- (void)finish:(std::optional<std::string>)directory {
  if (finished_) return;
  finished_ = YES;
  auto decision = std::move(decision_);
  if (decision) decision(std::move(directory));
}
- (void)begin:(NSWindow*)window {
  __weak HHExtensionDirectoryPrompt* weakSelf = self;
  [panel_ beginSheetModalForWindow:window completionHandler:^(NSModalResponse response) {
    HHExtensionDirectoryPrompt* prompt = weakSelf;
    if (!prompt || prompt->finished_) return;
    std::optional<std::string> directory;
    if (response == NSModalResponseOK && prompt->panel_.URLs.count == 1) {
      NSURL* url = prompt->panel_.URLs.firstObject;
      NSData* bytes = [url.path dataUsingEncoding:NSUTF8StringEncoding];
      if (url.isFileURL && bytes.length > 0 && bytes.length <= 4096) {
        std::string path(static_cast<const char*>(bytes.bytes), bytes.length);
        if (path.front() == '/' && path.find('\0') == std::string::npos)
          directory = std::move(path);
      }
    }
    [prompt finish:std::move(directory)];
  }];
}
- (BOOL)active { return !finished_; }
- (void)cancel {
  if (finished_) return;
  [panel_ cancel:nil];
  if (panel_.sheetParent)
    [panel_.sheetParent endSheet:panel_ returnCode:NSModalResponseCancel];
  [panel_ orderOut:nil];
  [self finish:std::nullopt];
}
@end

struct NativeExtensionDirectoryPicker::Impl {
  HHExtensionDirectoryPrompt* prompt;
};
NativeExtensionDirectoryPicker::NativeExtensionDirectoryPicker(std::unique_ptr<Impl> impl)
    : impl_(std::move(impl)) {}
NativeExtensionDirectoryPicker::~NativeExtensionDirectoryPicker() { Cancel(); }
bool NativeExtensionDirectoryPicker::active() const {
  CEF_REQUIRE_UI_THREAD();
  return [impl_->prompt active];
}
void NativeExtensionDirectoryPicker::Cancel() {
  CEF_REQUIRE_UI_THREAD();
  [impl_->prompt cancel];
}
std::unique_ptr<NativeExtensionDirectoryPicker> NativeExtensionDirectoryPicker::Show(
    CefWindowHandle parent, const std::string& requester, const std::string& profile_id,
    std::function<void(std::optional<std::string>)> decision) {
  CEF_REQUIRE_UI_THREAD();
  if (!parent || !decision) return nullptr;
  NSWindow* window = ((__bridge NSView*)parent).window;
  if (!window || window.attachedSheet) return nullptr;
  auto impl = std::make_unique<Impl>();
  impl->prompt = [[HHExtensionDirectoryPrompt alloc]
      initWithRequester:requester profile:profile_id decision:std::move(decision)];
  [impl->prompt begin:window];
  return std::unique_ptr<NativeExtensionDirectoryPicker>(
      new NativeExtensionDirectoryPicker(std::move(impl)));
}
