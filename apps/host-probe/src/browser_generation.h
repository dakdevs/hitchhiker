// Copyright (c) 2026 Hitchhiker contributors.
// SPDX-License-Identifier: BSD-3-Clause
#ifndef HITCHHIKER_HOST_PROBE_BROWSER_GENERATION_H_
#define HITCHHIKER_HOST_PROBE_BROWSER_GENERATION_H_
#pragma once
#include <cstdint>
#include <limits>

// CEF browser instances are represented by an opaque host identity. This
// production helper is CEF-free for non-GUI tests.
class BrowserGenerationTracker {
 public:
  using Identity = uintptr_t;
  enum class AttachResult {
    kInitial,
    kReplacement,
    kDuplicate,
    kWindowDestroyed,
    kFinalized,
    kExhausted,
  };
  enum class DetachResult { kCurrent, kStale, kNone };
  explicit BrowserGenerationTracker(uint32_t initial_generation = 0)
      : generation_(initial_generation) {}
  AttachResult Attach(Identity identity) {
    if (identity == 0 || finalized_) return AttachResult::kFinalized;
    if (window_destroyed_) return AttachResult::kWindowDestroyed;
    if (available_ && identity == current_identity_) {
      return AttachResult::kDuplicate;
    }
    if (generation_ == std::numeric_limits<uint32_t>::max()) {
      return AttachResult::kExhausted;
    }
    const bool initial = generation_ == 0;
    ++generation_;
    available_ = true;
    current_identity_ = identity;
    return initial ? AttachResult::kInitial : AttachResult::kReplacement;
  }
  DetachResult Detach(Identity identity) {
    if (!available_) return DetachResult::kNone;
    if (identity == 0 || identity != current_identity_) {
      return DetachResult::kStale;
    }
    available_ = false;
    current_identity_ = 0;
    return DetachResult::kCurrent;
  }
  void MarkWindowDestroyed() { window_destroyed_ = true; }
  bool CanFinalize() const { return window_destroyed_ && !available_; }
  void Finalize() {
    if (CanFinalize()) finalized_ = true;
  }
  uint32_t generation() const { return generation_; }
  Identity current_identity() const { return current_identity_; }
  bool available() const { return available_; }
  bool finalized() const { return finalized_; }
 private:
  uint32_t generation_ = 0;
  Identity current_identity_ = 0;
  bool available_ = false;
  bool window_destroyed_ = false;
  bool finalized_ = false;
};

#endif  // HITCHHIKER_HOST_PROBE_BROWSER_GENERATION_H_
