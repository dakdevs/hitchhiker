#include <cstdio>
#include <limits>

#include "src/browser_generation.h"

namespace {

int failures = 0;

void Check(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "browser_generation_test: %s\n", message);
    ++failures;
  }
}

}  // namespace

int main() {
  using Tracker = BrowserGenerationTracker;
  constexpr Tracker::Identity kA = 0xA;
  constexpr Tracker::Identity kB = 0xB;
  constexpr Tracker::Identity kC = 0xC;

  // Create-new-before-destroy-old, duplicate creation, then stale A/B after C.
  Tracker create_first;
  Check(create_first.Attach(kA) == Tracker::AttachResult::kInitial,
        "initial A");
  Check(create_first.Attach(kA) == Tracker::AttachResult::kDuplicate,
        "duplicate A");
  Check(create_first.Attach(kB) == Tracker::AttachResult::kReplacement,
        "replace B");
  Check(create_first.Detach(kA) == Tracker::DetachResult::kStale,
        "stale A after B");
  Check(create_first.Attach(kC) == Tracker::AttachResult::kReplacement,
        "replace C");
  Check(create_first.Detach(kA) == Tracker::DetachResult::kStale,
        "stale A after C");
  Check(create_first.Detach(kB) == Tracker::DetachResult::kStale,
        "stale B after C");
  Check(create_first.generation() == 3 &&
            create_first.current_identity() == kC,
        "C retained");

  // Destroy-old-before-create-new has a real unavailable gap.
  Tracker destroy_first;
  Check(destroy_first.Attach(kA) == Tracker::AttachResult::kInitial,
        "destroy-first initial");
  Check(destroy_first.Detach(kA) == Tracker::DetachResult::kCurrent &&
            !destroy_first.available(),
        "unavailable gap");
  Check(destroy_first.Attach(kB) == Tracker::AttachResult::kReplacement,
        "attach after gap");

  // Current-browser-first, window-first, and close during a gap.
  Tracker browser_first;
  browser_first.Attach(kA);
  browser_first.Detach(kA);
  Check(!browser_first.CanFinalize(), "browser-first waits for window");
  browser_first.MarkWindowDestroyed();
  browser_first.Finalize();
  Check(browser_first.finalized(), "browser-first finalized");

  Tracker window_first;
  window_first.Attach(kA);
  window_first.MarkWindowDestroyed();
  Check(!window_first.CanFinalize(), "window-first waits for browser");
  window_first.Detach(kA);
  window_first.Finalize();
  Check(window_first.finalized(), "window-first finalized");

  Tracker close_gap;
  close_gap.Attach(kA);
  close_gap.Detach(kA);
  close_gap.MarkWindowDestroyed();
  close_gap.Finalize();
  Check(close_gap.Attach(kB) == Tracker::AttachResult::kFinalized,
        "late attach rejected");

  Tracker exhausted(std::numeric_limits<uint32_t>::max());
  Check(exhausted.Attach(kA) == Tracker::AttachResult::kExhausted,
        "exhaustion safe");

  return failures == 0 ? 0 : 1;
}
