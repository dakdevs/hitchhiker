#pragma once

#import <AppKit/AppKit.h>

#include <cstddef>

inline NSBitmapImageRep* CreateRasterBitmap(unsigned char* pixels, size_t width, size_t height) {
  unsigned char* planes[5] = {pixels, nullptr, nullptr, nullptr, nullptr};
  return [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:planes
                    pixelsWide:static_cast<NSInteger>(width)
                    pixelsHigh:static_cast<NSInteger>(height)
                 bitsPerSample:8
               samplesPerPixel:4
                      hasAlpha:YES
                      isPlanar:NO
                colorSpaceName:NSDeviceRGBColorSpace
                   bytesPerRow:static_cast<NSInteger>(width * 4)
                  bitsPerPixel:32];
}
