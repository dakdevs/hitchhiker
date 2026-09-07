#import <AppKit/AppKit.h>

#include <array>
#include <cassert>
#include <cmath>

#include "src/raster_bitmap.h"

static NSColor* RenderPixel(NSBitmapImageRep* source) {
  NSBitmapImageRep* destination = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:nullptr
                    pixelsWide:1
                    pixelsHigh:1
                 bitsPerSample:8
               samplesPerPixel:4
                      hasAlpha:YES
                      isPlanar:NO
                colorSpaceName:NSDeviceRGBColorSpace
                   bytesPerRow:4
                  bitsPerPixel:32];
  assert(destination != nil);
  NSGraphicsContext* context = [NSGraphicsContext graphicsContextWithBitmapImageRep:destination];
  assert(context != nil);
  [NSGraphicsContext saveGraphicsState];
  [NSGraphicsContext setCurrentContext:context];
  [source drawInRect:NSMakeRect(0, 0, 1, 1)];
  [context flushGraphics];
  [NSGraphicsContext restoreGraphicsState];
  return [destination colorAtX:0 y:0];
}

static void ExpectColor(NSColor* color, CGFloat red, CGFloat green, CGFloat blue) {
  NSColor* rgb = [color colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
  assert(rgb != nil);
  assert(std::fabs(rgb.redComponent - red) < 0.01);
  assert(std::fabs(rgb.greenComponent - green) < 0.01);
  assert(std::fabs(rgb.blueComponent - blue) < 0.01);
}

int main() {
  @autoreleasepool {
    std::array<unsigned char, 4> pixels = {255, 0, 0, 255};
    NSBitmapImageRep* red = CreateRasterBitmap(pixels.data(), 1, 1);
    assert(red != nil);
    assert(red.bitmapData == pixels.data());
    ExpectColor(RenderPixel(red), 1, 0, 0);

    pixels = {0, 0, 255, 255};
    NSBitmapImageRep* blue = CreateRasterBitmap(pixels.data(), 1, 1);
    assert(blue != nil);
    assert(blue.bitmapData == pixels.data());
    ExpectColor(RenderPixel(blue), 0, 0, 1);
  }
  return 0;
}
