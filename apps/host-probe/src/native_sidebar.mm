#import <Cocoa/Cocoa.h>
#include "src/native_sidebar.h"
#include <vector>
#include <cstring>
extern "C" {
struct NativePixels { uintptr_t width, height, byte_len; };
void* native_sdk_app_create();
void native_sdk_app_destroy(void*);
void native_sdk_app_start(void*);
void native_sdk_app_stop(void*);
void native_sdk_app_frame(void*);
void native_sdk_app_viewport(void*,float,float,float,void*,float,float,float,float,float,float,float,float);
int native_sdk_app_render_pixel_size(void*,float,NativePixels*);
int native_sdk_app_render_pixels(void*,float,uint8_t*,uintptr_t,NativePixels*);
void native_sdk_app_touch(void*,uint64_t,int,float,float,float);
void native_sdk_app_command(void*,const char*,uintptr_t);
int hitchhiker_take_navigation();
}
@interface HHNativeSidebar : NSView {
  void* app_;
  CefRefPtr<CefBrowser> browser_;
  NSTimer* timer_;
}
- (instancetype)initWithBrowser:(CefRefPtr<CefBrowser>)browser;
- (void)tick;
- (void)stop;
- (void)loaded;
@end
static NSMutableDictionary<NSNumber*,HHNativeSidebar*>* sidebars;
@implementation HHNativeSidebar
- (BOOL)isFlipped { return YES; }
- (instancetype)initWithBrowser:(CefRefPtr<CefBrowser>)browser {
  self = [super initWithFrame:NSMakeRect(0,0,260,600)];
  if (self) {
    browser_ = browser;
    app_ = native_sdk_app_create();
    if (!app_) return nil;
    native_sdk_app_start(app_);
    __weak HHNativeSidebar* weakSelf = self;
    timer_ = [NSTimer scheduledTimerWithTimeInterval:1.0/30.0 repeats:YES block:^(NSTimer*) { [weakSelf tick]; }];
    [self tick];
  }
  return self;
}
- (void)stop {
  [timer_ invalidate]; timer_ = nil;
  if (app_) { native_sdk_app_stop(app_); native_sdk_app_destroy(app_); app_ = nullptr; }
  browser_ = nullptr;
}
- (void)tick {
  if (!app_) return;
  native_sdk_app_viewport(app_,260,self.bounds.size.height,1,nullptr,0,0,0,0,0,0,0,0);
  native_sdk_app_frame(app_);
  if (hitchhiker_take_navigation() && browser_) {
    fprintf(stderr,"HITCHHIKER_NATIVE_NAVIGATE\n");
    browser_->GetMainFrame()->LoadURL("data:text/html,<title>Hitchhiker%20fixture</title><body%20style='font:24px%20system-ui;padding:60px'><h1>Chromium%20page</h1><p>Opened%20from%20a%20Native%20button.</p><input%20placeholder='Type%20here%20to%20test%20focus'></body>");
  }
  [self setNeedsDisplay:YES];
}
- (void)loaded {
  if (app_) { native_sdk_app_command(app_,"page.loaded",11); [self tick]; }
  fprintf(stderr,"HITCHHIKER_CHROMIUM_EVENT\n");
}
- (void)drawRect:(NSRect)dirtyRect {
  if (!app_) return;
  NativePixels size{};
  if (!native_sdk_app_render_pixel_size(app_,1,&size) || !size.byte_len) return;
  std::vector<uint8_t> pixels(size.byte_len);
  if (!native_sdk_app_render_pixels(app_,1,pixels.data(),pixels.size(),&size)) return;
  NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr pixelsWide:size.width pixelsHigh:size.height bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:size.width*4 bitsPerPixel:32];
  memcpy(rep.bitmapData,pixels.data(),size.byte_len);
  [rep drawInRect:self.bounds];
}
- (void)mouseDown:(NSEvent*)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  native_sdk_app_touch(app_,1,0,point.x,point.y,1); [self tick];
}
- (void)mouseUp:(NSEvent*)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  native_sdk_app_touch(app_,1,1,point.x,point.y,0); [self tick];
}
@end
void* InstallNativeSidebar(CefRefPtr<CefWindow> window, CefRefPtr<CefBrowser> browser) {
  if (!window || !browser) return nullptr;
  NSView* handle = (__bridge NSView*)window->GetWindowHandle();
  if (!handle || !handle.window.contentView) return nullptr;
  HHNativeSidebar* sidebar = [[HHNativeSidebar alloc] initWithBrowser:browser];
  if (!sidebar) return nullptr;
  [handle.window.contentView addSubview:sidebar positioned:NSWindowAbove relativeTo:nil];
  if (!sidebars) sidebars = [NSMutableDictionary dictionary];
  sidebars[@(browser->GetIdentifier())] = sidebar;
  fprintf(stderr,"HITCHHIKER_NATIVE_MOUNT\n");
  return (__bridge_retained void*)sidebar;
}
void ResizeNativeSidebar(void* ptr, int height) {
  if (ptr) { HHNativeSidebar* sidebar = (__bridge HHNativeSidebar*)ptr; sidebar.frame = NSMakeRect(0,0,260,height); }
}
void DestroyNativeSidebar(void* ptr) {
  if (!ptr) return;
  HHNativeSidebar* sidebar = (__bridge_transfer HHNativeSidebar*)ptr;
  for (NSNumber* key in [sidebars allKeys]) if (sidebars[key] == sidebar) [sidebars removeObjectForKey:key];
  [sidebar stop]; [sidebar removeFromSuperview];
}
void NotifyNativeTitle(CefRefPtr<CefBrowser> browser) { [sidebars[@(browser->GetIdentifier())] loaded]; }
