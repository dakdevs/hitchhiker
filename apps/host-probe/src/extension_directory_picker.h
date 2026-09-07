#ifndef HITCHHIKER_EXTENSION_DIRECTORY_PICKER_H_
#define HITCHHIKER_EXTENSION_DIRECTORY_PICKER_H_

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include "include/cef_browser.h"

// Selection is private input to artifact validation, never permission approval.
class NativeExtensionDirectoryPicker {
 public:
  static std::unique_ptr<NativeExtensionDirectoryPicker> Show(
      CefWindowHandle parent, const std::string& requester,
      const std::string& profile_id,
      std::function<void(std::optional<std::string>)> decision);
  ~NativeExtensionDirectoryPicker();
  bool active() const;
  void Cancel();
 private:
  struct Impl;
  explicit NativeExtensionDirectoryPicker(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};

#endif
