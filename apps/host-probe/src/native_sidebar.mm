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
const char* native_sdk_app_last_error_name(void*);
int hitchhiker_next_command();
}
@interface HHNativeSidebar : NSView {
  void* app_;
  NativeCommandSink command_sink_;
  NSTimer* timer_;
  id input_monitor_;
  BOOL pointer_captured_;
}
- (instancetype)initWithSink:(NativeCommandSink)sink;
- (void)tick;
- (void)stop;
- (void)receiveCommand:(const char*)command;
@end

@implementation HHNativeSidebar
- (BOOL)isFlipped { return YES; }
- (instancetype)initWithSink:(NativeCommandSink)sink {
  self = [super initWithFrame:NSMakeRect(0,0,260,600)];
  if (self) {
    command_sink_ = std::move(sink);
    app_ = native_sdk_app_create();
    if (!app_) return nil;
    native_sdk_app_start(app_);
    __weak HHNativeSidebar* weakSelf = self;
    input_monitor_ = [NSEvent addLocalMonitorForEventsMatchingMask:
        (NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDragged)
        handler:^NSEvent*(NSEvent* event) {
      HHNativeSidebar* sidebar = weakSelf;
      if (!sidebar || !sidebar->app_ || event.window != sidebar.window) return event;
      NSPoint point = [sidebar convertPoint:event.locationInWindow fromView:nil];
      BOOL inside = NSPointInRect(point, sidebar.bounds);
      if (event.type == NSEventTypeLeftMouseDown) {
        if (!inside) return event;
        sidebar->pointer_captured_ = YES;
        [sidebar mouseDown:event];
      } else {
        if (!sidebar->pointer_captured_) return event;
        if (event.type == NSEventTypeLeftMouseUp) {
          sidebar->pointer_captured_ = NO;
          [sidebar mouseUp:event];
        } else {
          native_sdk_app_touch(sidebar->app_,1,2,point.x,point.y,1);
          [sidebar tick];
        }
      }
      return nil;
    }];
    timer_ = [NSTimer scheduledTimerWithTimeInterval:1.0/30.0 repeats:YES block:^(NSTimer*) { [weakSelf tick]; }];
    [self tick];
  }
  return self;
}
- (void)stop {
  if (input_monitor_) { [NSEvent removeMonitor:input_monitor_]; input_monitor_ = nil; }
  [timer_ invalidate]; timer_ = nil;
  if (app_) { native_sdk_app_stop(app_); native_sdk_app_destroy(app_); app_ = nullptr; }
  command_sink_ = {};
}
- (void)tick {
  if (!app_) return;
  native_sdk_app_viewport(app_,260,self.bounds.size.height,1,nullptr,0,0,0,0,0,0,0,0);
  native_sdk_app_frame(app_);
  while (int command = hitchhiker_next_command()) {
    if (command_sink_) command_sink_(static_cast<NativeCommand>(command));
  }
  [self setNeedsDisplay:YES];
}
- (void)receiveCommand:(const char*)command {
  if (!app_) return;
  native_sdk_app_command(app_,command,strlen(command));
  [self tick];
}
- (void)drawRect:(NSRect)dirtyRect {
  if (!app_) return;
  NativePixels size{};
  if (!native_sdk_app_render_pixel_size(app_,1,&size) || !size.byte_len) return;
  std::vector<uint8_t> pixels(size.byte_len);
  if (!native_sdk_app_render_pixels(app_,1,pixels.data(),pixels.size(),&size)) return;
  NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr pixelsWide:size.width pixelsHigh:size.height bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:size.width*4 bitsPerPixel:32];
  memcpy(rep.bitmapData,pixels.data(),size.byte_len);
  [rep drawInRect:self.bounds fromRect:NSZeroRect
       operation:NSCompositingOperationCopy fraction:1
       respectFlipped:YES hints:nil];
}
- (void)mouseDown:(NSEvent*)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  native_sdk_app_touch(app_,1,0,point.x,point.y,1);

  [self tick];
}
- (void)mouseUp:(NSEvent*)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  native_sdk_app_touch(app_,1,1,point.x,point.y,0);

  [self tick];
}
@end
void* InstallNativeSidebar(CefRefPtr<CefWindow> window, NativeCommandSink sink) {
  if (!window || !sink) return nullptr;
  NSView* handle = (__bridge NSView*)window->GetWindowHandle();
  if (!handle || !handle.window.contentView) return nullptr;
  HHNativeSidebar* sidebar = [[HHNativeSidebar alloc] initWithSink:std::move(sink)];
  if (!sidebar) return nullptr;
  [handle.window.contentView addSubview:sidebar positioned:NSWindowAbove relativeTo:nil];
  fprintf(stderr,"HITCHHIKER_NATIVE_MOUNT\n");
  return (__bridge_retained void*)sidebar;
}
void ResizeNativeSidebar(void* ptr, int height) {
  if (ptr) {
    HHNativeSidebar* sidebar = (__bridge HHNativeSidebar*)ptr;
    sidebar.frame = NSMakeRect(0,0,260,height);
  }
}
void DestroyNativeSidebar(void* ptr) {
  if (!ptr) return;
  HHNativeSidebar* sidebar = (__bridge_transfer HHNativeSidebar*)ptr;
  [sidebar stop];
  [sidebar removeFromSuperview];
}
void NotifyNativeState(void* ptr, const char* command) {
  if (ptr) [(__bridge HHNativeSidebar*)ptr receiveCommand:command];
}
