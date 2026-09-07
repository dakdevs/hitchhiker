#ifndef HITCHHIKER_EXTENSION_REVIEW_H_
#define HITCHHIKER_EXTENSION_REVIEW_H_

#include <functional>
#include <memory>
#include <string>
#include <vector>
#include "include/cef_browser.h"

struct ExtensionReviewMetadata {
  std::string requester;
  std::string profile_id;
  std::string name;
  std::string version;
  std::string installation_id;
  std::string digest;
  std::string chromium_id;
  std::vector<std::string> permissions;
  std::vector<std::string> host_permissions;
  std::vector<std::string> optional_permissions;
  std::vector<std::string> optional_host_permissions;
};

// UI-thread-owned permission sheet. Approval comes only from its AppKit button.
// The caller must bind metadata and decisions to its private reviewed artifact.
class NativeExtensionReview {
 public:
  static std::unique_ptr<NativeExtensionReview> Show(
      CefWindowHandle parent, const ExtensionReviewMetadata& metadata,
      std::function<void(bool)> decision);
  ~NativeExtensionReview();
  bool active() const;
  void Cancel();
 private:
  struct Impl;
  explicit NativeExtensionReview(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};

#endif
