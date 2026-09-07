#import <Cocoa/Cocoa.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>
#include "src/native_sidebar.h"
#include "src/raster_bitmap.h"

extern "C" {
struct NativePixels { uintptr_t width, height, byte_len; };
struct NativePixelsDamage {
  uintptr_t width, height, byte_len;
  uintptr_t damage_x, damage_y, damage_width, damage_height;
  uint64_t revision;
};
struct NativeGpuFrameState {
  uint64_t surface_id, window_id;
  float width, height, scale;
  uint64_t frame_index, timestamp_ns, frame_interval_ns;
  uint64_t input_timestamp_ns, input_latency_ns, input_latency_budget_ns;
  uintptr_t input_latency_budget_exceeded_count;
  int input_latency_budget_ok;
  uint64_t first_frame_latency_ns, first_frame_latency_budget_ns;
  uintptr_t first_frame_latency_budget_exceeded_count;
  int first_frame_latency_budget_ok, nonblank;
  uint32_t sample_color;
  int status, vsync;
  uint64_t canvas_revision;
  uintptr_t canvas_command_count;
  int canvas_frame_requires_render, canvas_frame_full_repaint;
  uintptr_t canvas_frame_batch_count, canvas_frame_budget_exceeded_count;
  int canvas_frame_budget_ok;
  uint64_t widget_revision;
  uintptr_t widget_node_count, widget_semantics_count;
};
struct NativeInput { int active; uint64_t id; float x, y, width, height; };
struct NativeDragRegion { float x, y, width, height; int draggable; };
size_t hitchhiker_drag_regions(void*, NativeDragRegion*, size_t);
struct NativeGeometry { uint64_t id; int caret; float x, y, width, height; };
struct NativeSemantics { uint64_t id, parent; int role; uint32_t flags, actions; float x,y,width,height,value; int has_value; const char* label; uintptr_t label_len; const char* text; uintptr_t text_len; const char* placeholder; uintptr_t placeholder_len; intptr_t selection_start, selection_end, composition_start, composition_end; };
void* native_sdk_app_create(); void native_sdk_app_destroy(void*); void native_sdk_app_start(void*); void native_sdk_app_stop(void*); void native_sdk_app_frame(void*);
void native_sdk_app_viewport(void*,float,float,float,void*,float,float,float,float,float,float,float,float);
int native_sdk_app_gpu_frame_state(void*,NativeGpuFrameState*);
int native_sdk_app_render_pixel_size(void*,float,NativePixels*);
int native_sdk_app_render_pixels(void*,float,uint8_t*,uintptr_t,NativePixels*);
int native_sdk_app_render_pixels_damage(void*,float,uint8_t*,uintptr_t,NativePixelsDamage*);
void native_sdk_app_touch(void*,uint64_t,int,float,float,float); void native_sdk_app_scroll(void*,uint64_t,float,float,float,float);
void native_sdk_app_key(void*,int,const char*,uintptr_t,const char*,uintptr_t,uint32_t); void native_sdk_app_text(void*,const char*,uintptr_t); void native_sdk_app_ime(void*,int,const char*,uintptr_t,intptr_t);
void native_sdk_app_command(void*,const char*,uintptr_t);
int native_sdk_app_text_input_state(void*,NativeInput*); int native_sdk_app_widget_semantics_by_id(void*,uint64_t,NativeSemantics*); int native_sdk_app_widget_text_geometry(void*,uint64_t,NativeGeometry*);
int hitchhiker_next_command(); int hitchhiker_commit_tree(void*,const uint8_t*,size_t,uint64_t); size_t hitchhiker_next_event(uint8_t*,size_t); size_t hitchhiker_sync_viewports(void*); void hitchhiker_after_frame();
}
namespace {
constexpr size_t kMaxEventsPerTick = 32 * 1024;
constexpr size_t kMaxRasterBytes = 256 * 1024 * 1024;
NSUInteger Utf16ForUtf8(NSString* text, uintptr_t offset) { NSUInteger i=0; uintptr_t total=0; while(i<text.length) { NSRange r=[text rangeOfComposedCharacterSequenceAtIndex:i]; uintptr_t n=[[text substringWithRange:r] lengthOfBytesUsingEncoding:NSUTF8StringEncoding]; if(total+n>offset) return i; total+=n; i=NSMaxRange(r); } return text.length; }
uintptr_t Utf8ForUtf16(NSString* text, NSUInteger index) { return [[text substringToIndex:std::min(index,text.length)] lengthOfBytesUsingEncoding:NSUTF8StringEncoding]; }
uint32_t Modifiers(NSEvent* e) { auto f=e.modifierFlags; return ((f&NSEventModifierFlagShift)?1:0)|((f&NSEventModifierFlagControl)?2:0)|((f&NSEventModifierFlagOption)?4:0)|((f&NSEventModifierFlagCommand)?8:0); }
}

@interface HHNativeSidebar : NSView<NSTextInputClient> {
  void* app_;
  NativeCommandSink commands_;
  NativeEventSink events_;
  std::function<void()> recovery_;
  CefRefPtr<CefWindow> root_window_;
  std::vector<CefDraggableRegion> drag_regions_;
  NSTimer* timer_;
  id monitor_;
  BOOL captured_;
  BOOL committed_;
  NSString* marked_;
  uint64_t focused_;

  uint8_t* raster_;
  size_t raster_capacity_;
  NSUInteger raster_width_;
  NSUInteger raster_height_;
  CGFloat raster_scale_;
  BOOL raster_ready_;
  NSBitmapImageRep* bitmap_;
  BOOL has_presented_revision_;
  uint64_t last_canvas_revision_;
  uint64_t raster_ticks_;
  uint64_t raster_calls_;
  uint64_t raster_updates_;
  uint64_t raster_idle_;
  uint64_t raster_updated_bytes_;
}
- (instancetype)initWithSink:(NativeCommandSink)sink events:(NativeEventSink)events recovery:(std::function<void()>)recovery;
- (void)tick;
- (void)stop;
- (void)receiveCommand:(const char*)command;
- (BOOL)commit:(const char*)json length:(size_t)length revision:(uint64_t)revision;
- (void)attachRoot:(CefRefPtr<CefWindow>)window;
- (BOOL)isStandardControl:(NSPoint)point;
- (BOOL)isDragPoint:(NSPoint)point;
- (void)syncDragRegions;
- (BOOL)refreshBitmap;
- (CefRefPtr<CefDictionaryValue>)windowChrome;
@end

@implementation HHNativeSidebar
- (BOOL)isFlipped { return YES; } - (BOOL)acceptsFirstResponder { return YES; } - (BOOL)acceptsFirstMouse:(NSEvent*)event { return YES; }
- (BOOL)isAccessibilityElement { return YES; } - (NSAccessibilityRole)accessibilityRole { return NSAccessibilityGroupRole; } - (NSString*)accessibilityLabel { return @"Hitchhiker native interface"; }
- (instancetype)initWithSink:(NativeCommandSink)sink events:(NativeEventSink)events recovery:(std::function<void()>)recovery {
  if (!(self=[super initWithFrame:NSMakeRect(0,0,260,600)])) return nil; commands_=std::move(sink); events_=std::move(events); marked_=@"";
  app_=native_sdk_app_create(); if(!app_) return nil; native_sdk_app_start(app_); __weak HHNativeSidebar* weak=self;
  recovery_=std::move(recovery);
  monitor_=[NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskKeyDown|NSEventMaskLeftMouseDown|NSEventMaskLeftMouseUp|NSEventMaskLeftMouseDragged) handler:^NSEvent*(NSEvent* e) {
    HHNativeSidebar* s=weak;
    if(!s||!s->app_) return e;
    if(e.type==NSEventTypeKeyDown) {
      const auto modifiers=e.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagShift|NSEventModifierFlagControl|NSEventModifierFlagOption);
      if(e.keyCode==53 && modifiers==(NSEventModifierFlagCommand|NSEventModifierFlagShift) && s->recovery_) {
        if(!e.isARepeat) s->recovery_();
        return nil;
      }
      return e;
    }
    if(e.window!=s.window) return e;
    NSPoint p=[s convertPoint:e.locationInWindow fromView:nil];
    if(e.type==NSEventTypeLeftMouseDown && [s isStandardControl:p]) return e;
    if(e.type==NSEventTypeLeftMouseDown && [s isDragPoint:p]) {
      [s.window performWindowDragWithEvent:e];
      return nil;
    }
    if(e.type==NSEventTypeLeftMouseDown) { if(!NSPointInRect(p,s.bounds)) return e; s->captured_=YES; [s mouseDown:e]; return nil; }
    if(!s->captured_) return e;
    if(e.type==NSEventTypeLeftMouseUp) { s->captured_=NO; [s mouseUp:e]; }
    else { native_sdk_app_touch(s->app_,1,2,p.x,p.y,1); [s tick]; }
    return nil;
  }];
  timer_=[NSTimer scheduledTimerWithTimeInterval:1.0/30.0 repeats:YES block:^(NSTimer*) { [weak tick]; }]; [self tick]; return self;
}
- (void)stop {
  if (root_window_ && !root_window_->IsClosed()) root_window_->SetDraggableRegions({});
  root_window_ = nullptr;
  drag_regions_.clear();
  if (monitor_) {
    [NSEvent removeMonitor:monitor_];
    monitor_ = nil;
  }
  [timer_ invalidate];
  timer_ = nil;
  if (app_) {
    native_sdk_app_stop(app_);
    native_sdk_app_destroy(app_);
    app_ = nullptr;
  }
  if (raster_ticks_) {
    fprintf(stderr,
            "HITCHHIKER_NATIVE_RASTER ticks=%llu calls=%llu updates=%llu idle=%llu updated_bytes=%llu\n",
            static_cast<unsigned long long>(raster_ticks_),
            static_cast<unsigned long long>(raster_calls_),
            static_cast<unsigned long long>(raster_updates_),
            static_cast<unsigned long long>(raster_idle_),
            static_cast<unsigned long long>(raster_updated_bytes_));
  }
  bitmap_ = nil;
  std::free(raster_);
  raster_ = nullptr;
  raster_capacity_ = 0;
  commands_ = {};
  events_ = {};
  recovery_ = {};
}
- (void)drainEvents { if(!committed_||!events_) return; size_t remaining=kMaxEventsPerTick; while(remaining) { size_t n=hitchhiker_next_event(nullptr,0); if(!n||n>remaining||n>kMaxEventsPerTick) break; std::vector<uint8_t> bytes(n); if(hitchhiker_next_event(bytes.data(),bytes.size())!=n) break; events_(std::string(reinterpret_cast<const char*>(bytes.data()),n)); remaining-=n; } }
- (void)syncText { NativeInput input{}; if(!app_||!native_sdk_app_text_input_state(app_,&input)) return; if(input.active) { focused_=input.id; if(self.window.firstResponder!=self) [self.window makeFirstResponder:self]; } else { focused_=0; marked_=@""; } }
- (CGFloat)backingScale {
  CGFloat scale = self.window.backingScaleFactor;
  if (!(scale > 0) || !std::isfinite(scale)) scale = self.window.screen.backingScaleFactor;
  if (!(scale > 0) || !std::isfinite(scale)) scale = NSScreen.mainScreen.backingScaleFactor;
  return scale > 0 && std::isfinite(scale) ? scale : 1;
}

- (void)clearRasterCache {
  bitmap_ = nil;
  std::free(raster_);
  raster_ = nullptr;
  raster_capacity_ = 0;
  raster_width_ = 0;
  raster_height_ = 0;
  raster_scale_ = 0;
  raster_ready_ = NO;
  has_presented_revision_ = NO;
}

- (BOOL)ensureRasterFor:(const NativePixels&)info scale:(CGFloat)scale fresh:(BOOL*)fresh {
  *fresh = NO;
  if (!info.width || !info.height ||
      info.width > std::numeric_limits<size_t>::max() / 4 ||
      info.height > std::numeric_limits<size_t>::max() / (info.width * 4)) {
    return NO;
  }
  const size_t expected = info.width * info.height * 4;
  if (info.byte_len != expected || expected > kMaxRasterBytes) return NO;

  if (raster_ && raster_width_ == info.width && raster_height_ == info.height &&
      raster_scale_ == scale && raster_capacity_ == expected && bitmap_) {
    return YES;
  }

  bitmap_ = nil;
  void* next = std::realloc(raster_, expected);
  if (!next) return NO;
  raster_ = static_cast<uint8_t*>(next);
  raster_capacity_ = expected;
  raster_width_ = info.width;
  raster_height_ = info.height;
  raster_scale_ = scale;
  raster_ready_ = NO;

  if (![self refreshBitmap]) return NO;
  *fresh = YES;
  return YES;
}

- (BOOL)refreshBitmap {
  bitmap_ = CreateRasterBitmap(raster_, raster_width_, raster_height_);
  if (!bitmap_) {
    return NO;
  }
  return YES;
}

- (void)updateRasterAtScale:(CGFloat)scale {
  NativePixels info{};
  if (!native_sdk_app_render_pixel_size(app_, static_cast<float>(scale), &info)) return;

  BOOL fresh = NO;
  if (![self ensureRasterFor:info scale:scale fresh:&fresh]) return;

  NativePixelsDamage rendered{};
  if (!native_sdk_app_render_pixels_damage(app_, static_cast<float>(scale), raster_,
                                            raster_capacity_, &rendered)) {
    return;
  }
  ++raster_calls_;
  if (rendered.width != raster_width_ || rendered.height != raster_height_ ||
      rendered.byte_len != raster_capacity_) {
    return;
  }

  size_t damage_x = rendered.damage_x;
  size_t damage_y = rendered.damage_y;
  size_t damage_width = rendered.damage_width;
  size_t damage_height = rendered.damage_height;
  if (damage_x > raster_width_ || damage_y > raster_height_ ||
      damage_width > raster_width_ - damage_x ||
      damage_height > raster_height_ - damage_y) {
    return;
  }

  // Replacing the retained buffer is only expected on size or scale changes,
  // for which Native reports full damage. Fall back to a full render if that
  // invariant is ever broken so an uninitialized bitmap cannot reach AppKit.
  if (fresh &&
      (damage_x != 0 || damage_y != 0 || damage_width != raster_width_ ||
       damage_height != raster_height_)) {
    NativePixels full{};
    if (!native_sdk_app_render_pixels(app_, static_cast<float>(scale), raster_,
                                      raster_capacity_, &full) ||
        full.width != raster_width_ || full.height != raster_height_ ||
        full.byte_len != raster_capacity_) {
      return;
    }
    damage_x = 0;
    damage_y = 0;
    damage_width = raster_width_;
    damage_height = raster_height_;
  }

  raster_ready_ = YES;
  has_presented_revision_ = YES;
  last_canvas_revision_ = rendered.revision;
  if (!damage_width || !damage_height) {
    ++raster_idle_;
    return;
  }

  // AppKit caches drawInRect's image even when external bitmap bytes change.
  // Rewrap only changed frames; keep the pixel allocation and all idle frames.
  if (!fresh && ![self refreshBitmap]) {
    [self clearRasterCache];
    return;
  }
  ++raster_updates_;
  raster_updated_bytes_ += damage_width * damage_height * 4;
  NSRect damage = NSMakeRect(damage_x / scale, damage_y / scale,
                             damage_width / scale, damage_height / scale);
  damage = NSIntersectionRect(damage, self.bounds);
  if (!NSIsEmptyRect(damage)) [self setNeedsDisplayInRect:damage];
}

- (void)tick {
  if (!app_) return;
  const CGFloat scale = [self backingScale];
  native_sdk_app_viewport(app_, self.bounds.size.width, self.bounds.size.height,
                          static_cast<float>(scale), nullptr, 0, 0, 0, 0, 0, 0, 0, 0);
  native_sdk_app_frame(app_);
  hitchhiker_after_frame();
  ++raster_ticks_;
  while (int command = hitchhiker_next_command()) {
    if (commands_) commands_(static_cast<NativeCommand>(command));
  }
  if (committed_) hitchhiker_sync_viewports(app_);
  [self syncDragRegions];
  [self drainEvents];
  [self syncText];
  NativeGpuFrameState state{};
  if (raster_ready_ && has_presented_revision_ && raster_scale_ == scale &&
      native_sdk_app_gpu_frame_state(app_, &state) &&
      state.canvas_revision == last_canvas_revision_) {
    ++raster_idle_;
  } else {
    [self updateRasterAtScale:scale];
  }
}
- (BOOL)commit:(const char*)json length:(size_t)length revision:(uint64_t)revision { if(!app_||!json||!length||!revision||!hitchhiker_commit_tree(app_,reinterpret_cast<const uint8_t*>(json),length,revision)) return NO; committed_=YES; [self tick]; return YES; }
- (void)receiveCommand:(const char*)command { if(app_) { native_sdk_app_command(app_,command,strlen(command)); [self tick]; } }
- (void)drawRect:(NSRect)dirty {
  if (!raster_ready_ || !bitmap_) return;
  [bitmap_ drawInRect:self.bounds
             fromRect:NSZeroRect
            operation:NSCompositingOperationCopy
             fraction:1
       respectFlipped:YES
                hints:nil];
}

- (void)setFrameSize:(NSSize)newSize {
  const BOOL changed = !NSEqualSizes(self.frame.size, newSize);
  [super setFrameSize:newSize];
  if (changed) {
    [self clearRasterCache];
    [self tick];
  }
}

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  [self tick];
}

- (void)viewDidChangeBackingProperties {
  [super viewDidChangeBackingProperties];
  [self clearRasterCache];
  [self tick];
}
- (void)attachRoot:(CefRefPtr<CefWindow>)window { root_window_ = window; }
- (BOOL)isStandardControl:(NSPoint)point {
  for (NSWindowButton kind : {NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton}) {
    NSButton* button = [self.window standardWindowButton:kind];
    if (button && !button.isHiddenOrHasHiddenAncestor &&
        NSPointInRect(point, [self convertRect:button.bounds fromView:button])) return YES;
  }
  return NO;
}
- (BOOL)isDragPoint:(NSPoint)point {
  BOOL draggable = NO;
  for (const auto& region : drag_regions_) {
    const auto& r = region.bounds;
    if (NSPointInRect(point, NSMakeRect(r.x, r.y, r.width, r.height))) draggable = region.draggable;
  }
  return draggable;
}
- (NSView*)hitTest:(NSPoint)point {
  const NSPoint local = [self convertPoint:point fromView:self.superview];
  if ([self isStandardControl:local] || [self isDragPoint:local]) return nil;
  return [super hitTest:point];
}
- (void)syncDragRegions {
  if (!app_ || !root_window_ || root_window_->IsClosed()) return;
  NativeDragRegion measured[250];
  const size_t count = hitchhiker_drag_regions(app_, measured, 250);
  std::vector<CefDraggableRegion> next;
  for (size_t i = 0; i < std::min(count, size_t{250}); ++i) {
    const auto& r = measured[i];
    if (!std::isfinite(r.x) || !std::isfinite(r.y) || !std::isfinite(r.width) ||
        !std::isfinite(r.height) || r.width <= 0 || r.height <= 0) continue;
    NSRect clipped = NSIntersectionRect(NSMakeRect(r.x,r.y,r.width,r.height), self.bounds);
    if (NSIsEmptyRect(clipped)) continue;
    const int x = std::ceil(NSMinX(clipped)), y = std::ceil(NSMinY(clipped));
    const int width = std::floor(NSMaxX(clipped)) - x, height = std::floor(NSMaxY(clipped)) - y;
    if (width <= 0 || height <= 0) continue;
    CefDraggableRegion region;
    region.bounds = CefRect(x,y,width,height);
    region.draggable = r.draggable != 0;
    next.push_back(region);
  }
  // Native system controls always win, including when a custom interface
  // declares a drag leaf across their reserved area.
  for (NSWindowButton kind : {NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton}) {
    NSButton* button = [self.window standardWindowButton:kind];
    if (!button || button.isHiddenOrHasHiddenAncestor) continue;
    const NSRect clipped = NSIntersectionRect([self convertRect:button.bounds fromView:button], self.bounds);
    if (NSIsEmptyRect(clipped)) continue;
    const int x = std::floor(NSMinX(clipped)), y = std::floor(NSMinY(clipped));
    CefDraggableRegion region;
    region.bounds = CefRect(x, y, std::ceil(NSMaxX(clipped)) - x, std::ceil(NSMaxY(clipped)) - y);
    region.draggable = false;
    next.push_back(region);
  }
  const bool same = next.size() == drag_regions_.size() &&
      std::equal(next.begin(), next.end(), drag_regions_.begin(), [](const auto& a, const auto& b) {
        return a.draggable == b.draggable && a.bounds == b.bounds;
      });
  if (same) return;
  drag_regions_ = std::move(next);
  root_window_->SetDraggableRegions(drag_regions_);
}
- (CefRefPtr<CefDictionaryValue>)windowChrome {
  auto value = CefDictionaryValue::Create();
  value->SetDouble("width", self.bounds.size.width);
  value->SetDouble("height", self.bounds.size.height);
  value->SetDouble("windowWidth", self.window.frame.size.width);
  value->SetDouble("windowHeight", self.window.frame.size.height);
  value->SetBool("fullscreen", (self.window.styleMask & NSWindowStyleMaskFullScreen) != 0);
  value->SetBool("titleHidden", self.window.titleVisibility == NSWindowTitleHidden);
  auto controls = CefListValue::Create();
  for (NSWindowButton kind : {NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton}) {
    NSButton* button = [self.window standardWindowButton:kind];
    auto entry = CefDictionaryValue::Create();
    const NSRect r = button ? [self convertRect:button.bounds fromView:button] : NSZeroRect;
    entry->SetString("kind", kind == NSWindowCloseButton ? "close" : kind == NSWindowMiniaturizeButton ? "minimize" : "zoom");
    entry->SetBool("visible", button && !button.isHiddenOrHasHiddenAncestor);
    entry->SetBool("enabled", button.enabled);
    entry->SetDouble("x", r.origin.x); entry->SetDouble("y", r.origin.y);
    entry->SetDouble("width", r.size.width); entry->SetDouble("height", r.size.height);
    controls->SetDictionary(controls->GetSize(), entry);
  }
  value->SetList("controls", controls);
  auto regions = CefListValue::Create();
  for (const auto& region : drag_regions_) {
    auto entry = CefDictionaryValue::Create();
    entry->SetBool("draggable", region.draggable);
    entry->SetInt("x", region.bounds.x); entry->SetInt("y", region.bounds.y);
    entry->SetInt("width", region.bounds.width); entry->SetInt("height", region.bounds.height);
    regions->SetDictionary(regions->GetSize(), entry);
  }
  value->SetList("regions", regions);
  return value;
}
- (void)mouseDown:(NSEvent*)e { [self.window makeFirstResponder:self]; NSPoint p=[self convertPoint:e.locationInWindow fromView:nil]; native_sdk_app_touch(app_,1,0,p.x,p.y,1); [self tick]; }
- (void)mouseUp:(NSEvent*)e { NSPoint p=[self convertPoint:e.locationInWindow fromView:nil]; native_sdk_app_touch(app_,1,1,p.x,p.y,0); [self tick]; }
- (void)scrollWheel:(NSEvent*)e { NSPoint p=[self convertPoint:e.locationInWindow fromView:nil]; native_sdk_app_scroll(app_,1,p.x,p.y,e.scrollingDeltaX,e.scrollingDeltaY); [self tick]; }
- (void)keyDown:(NSEvent*)e { if(e.modifierFlags&NSEventModifierFlagCommand) { [super keyDown:e]; return; } [self interpretKeyEvents:@[e]]; }
- (void)emitKey:(NSString*)key event:(NSEvent*)event { const char* bytes=key.UTF8String?:""; uintptr_t len=[key lengthOfBytesUsingEncoding:NSUTF8StringEncoding]; native_sdk_app_key(app_,0,bytes,len,"",0,Modifiers(event)); native_sdk_app_key(app_,1,bytes,len,"",0,Modifiers(event)); }
- (NSString*)focusedText { NativeSemantics n{}; if(!app_||!focused_||!native_sdk_app_widget_semantics_by_id(app_,focused_,&n)||!n.text) return @""; return [[NSString alloc] initWithBytes:n.text length:n.text_len encoding:NSUTF8StringEncoding]?:@""; }
- (void)insertText:(id)value replacementRange:(NSRange)range { NSString* text=[value isKindOfClass:[NSAttributedString class]]?[value string]:value; if(!text.length) return; if(marked_.length) native_sdk_app_ime(app_,2,"",0,-1); marked_=@""; native_sdk_app_text(app_,text.UTF8String?:"",[text lengthOfBytesUsingEncoding:NSUTF8StringEncoding]); [self tick]; }
- (void)setMarkedText:(id)value selectedRange:(NSRange)selection replacementRange:(NSRange)range { NSString* text=[value isKindOfClass:[NSAttributedString class]]?[value string]:value; marked_=text?:@""; if(!marked_.length) native_sdk_app_ime(app_,2,"",0,-1); else native_sdk_app_ime(app_,0,marked_.UTF8String?:"",[marked_ lengthOfBytesUsingEncoding:NSUTF8StringEncoding],Utf8ForUtf16(marked_,NSMaxRange(selection))); [self tick]; }
- (void)unmarkText { if(marked_.length) native_sdk_app_ime(app_,1,"",0,-1); marked_=@""; [self tick]; }
- (NSRange)selectedRange { NativeSemantics n{}; NSString* text=[self focusedText]; if(!app_||!focused_||!native_sdk_app_widget_semantics_by_id(app_,focused_,&n)) return NSMakeRange(NSNotFound,0); NSUInteger a=Utf16ForUtf8(text,std::max<intptr_t>(0,n.selection_start)),b=Utf16ForUtf8(text,std::max<intptr_t>(0,n.selection_end)); return NSMakeRange(std::min(a,b),a>b?a-b:b-a); }
- (NSRange)markedRange { return marked_.length?NSMakeRange(0,marked_.length):NSMakeRange(NSNotFound,0); } - (BOOL)hasMarkedText { return marked_.length>0; }
- (NSAttributedString*)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual { NSString* text=[self focusedText]; NSRange safe=NSIntersectionRange(range,NSMakeRange(0,text.length)); if(actual) *actual=safe; return [[NSAttributedString alloc] initWithString:[text substringWithRange:safe]]; }
- (NSArray<NSAttributedStringKey>*)validAttributesForMarkedText { return @[]; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual { if(actual) *actual=range; NativeGeometry g{}; if(app_&&focused_&&native_sdk_app_widget_text_geometry(app_,focused_,&g)&&g.caret) return [self.window convertRectToScreen:NSMakeRect(g.x,g.y,g.width,g.height)]; return [self.window convertRectToScreen:self.bounds]; }
- (NSUInteger)characterIndexForPoint:(NSPoint)p { return self.selectedRange.location==NSNotFound?0:self.selectedRange.location; }
- (void)doCommandBySelector:(SEL)selector { NSString* n=NSStringFromSelector(selector); if([n isEqualToString:@"deleteBackward:"]) [self emitKey:@"backspace" event:NSApp.currentEvent]; else if([n isEqualToString:@"moveLeft:"]) [self emitKey:@"arrowleft" event:NSApp.currentEvent]; else if([n isEqualToString:@"moveRight:"]) [self emitKey:@"arrowright" event:NSApp.currentEvent]; else if([n isEqualToString:@"moveUp:"]) [self emitKey:@"arrowup" event:NSApp.currentEvent]; else if([n isEqualToString:@"moveDown:"]) [self emitKey:@"arrowdown" event:NSApp.currentEvent]; else if([n isEqualToString:@"insertNewline:"]) [self emitKey:@"enter" event:NSApp.currentEvent]; else [super doCommandBySelector:selector]; [self tick]; }
@end

void* InstallNativeSidebar(CefRefPtr<CefWindow> window, NativeCommandSink sink, NativeEventSink events, std::function<void()> recovery) { if(!window||!sink) return nullptr; NSView* host=(__bridge NSView*)window->GetWindowHandle(); if(!host||!host.window.contentView) return nullptr; HHNativeSidebar* view=[[HHNativeSidebar alloc] initWithSink:std::move(sink) events:std::move(events) recovery:std::move(recovery)]; if(!view) return nullptr; [view attachRoot:window]; [host.window.contentView addSubview:view positioned:NSWindowAbove relativeTo:nil]; fprintf(stderr,"HITCHHIKER_NATIVE_MOUNT\n"); return (__bridge_retained void*)view; }
void ResizeNativeSurface(void* ptr,int width,int height) { if(ptr) [(__bridge HHNativeSidebar*)ptr setFrame:NSMakeRect(0,0,std::max(1,width),std::max(1,height))]; }
void ResizeNativeSidebar(void* ptr,int height) { ResizeNativeSurface(ptr,260,height); }
bool CommitNativeTree(void* ptr,const char* json,size_t length,uint64_t revision) { return ptr&&[(__bridge HHNativeSidebar*)ptr commit:json length:length revision:revision]; }
void DestroyNativeSidebar(void* ptr) { if(!ptr) return; HHNativeSidebar* view=(__bridge_transfer HHNativeSidebar*)ptr; [view stop]; [view removeFromSuperview]; }
void NotifyNativeState(void* ptr,const char* command) { if(ptr&&command) [(__bridge HHNativeSidebar*)ptr receiveCommand:command]; }
CefRefPtr<CefDictionaryValue> ReadNativeWindowChrome(void* ptr) { return ptr ? [(__bridge HHNativeSidebar*)ptr windowChrome] : CefDictionaryValue::Create(); }
