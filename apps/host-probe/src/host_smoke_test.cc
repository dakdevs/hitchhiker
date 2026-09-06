#include "src/host_smoke_test.h"

#include <map>
#include <optional>
#include <sstream>
#include <utility>
#include <vector>

#include "include/base/cef_bind.h"
#include "include/base/cef_callback.h"
#include "include/cef_browser.h"
#include "include/cef_devtools_message_observer.h"
#include "include/cef_parser.h"
#include "include/cef_task.h"
#include "include/cef_values.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_closure_task.h"
#include "src/page_manager.h"

namespace {

constexpr int kSmokeTimeoutMs = 12'000;
constexpr int kViewportTransitions = 100;
constexpr int kLifecycleRounds = 12;
constexpr int kSidebarWidth = 260;
constexpr char kEphemeralPageId[] = "smoke-ephemeral";
constexpr char kFixtureOneUrl[] = "http://127.0.0.1:4319/one";

std::string RuntimeExpression(const std::string& marker, bool mutate) {
  std::ostringstream expression;
  expression << "(()=>{const i=document.querySelector('#fixture-input');"
             << "const b=document.querySelector('#fixture-increment');"
             << "if(!i||!b)throw new Error('fixture controls missing');";
  if (mutate) {
    expression << "i.value='" << marker << "';b.click();"
               << (marker == "two-smoke" ? "b.click();" : "");
  }
  expression << "return JSON.stringify({nonce:document.querySelector('#fixture-nonce')?.value,"
             << "input:i.value,counter:document.querySelector('#fixture-counter')?.value,"
             << "extension:document.querySelector('#fixture-extension-status')?.textContent});})()";
  return expression.str();
}

struct FixtureSnapshot {
  std::string nonce;
  std::string input;
  std::string counter;
  std::string extension;
};

std::optional<FixtureSnapshot> ReadRuntimeSnapshot(const void* result, size_t result_size) {
  CefRefPtr<CefValue> root = CefParseJSON(result, result_size, JSON_PARSER_RFC);
  if (!root || root->GetType() != VTYPE_DICTIONARY) return std::nullopt;
  CefRefPtr<CefDictionaryValue> response = root->GetDictionary();
  CefRefPtr<CefDictionaryValue> runtime = response->GetDictionary("result");
  if (!runtime || runtime->GetType("value") != VTYPE_STRING) return std::nullopt;
  const std::string serialized = runtime->GetString("value").ToString();
  CefRefPtr<CefValue> fixture = CefParseJSON(serialized.data(), serialized.size(), JSON_PARSER_RFC);
  if (!fixture || fixture->GetType() != VTYPE_DICTIONARY) return std::nullopt;
  CefRefPtr<CefDictionaryValue> values = fixture->GetDictionary();
  if (values->GetType("nonce") != VTYPE_STRING || values->GetType("input") != VTYPE_STRING ||
      values->GetType("counter") != VTYPE_STRING || values->GetType("extension") != VTYPE_STRING)
    return std::nullopt;
  return FixtureSnapshot{values->GetString("nonce").ToString(),
                         values->GetString("input").ToString(),
                         values->GetString("counter").ToString(),
                         values->GetString("extension").ToString()};
}

std::optional<bool> ReadRuntimeBoolean(const void* result, size_t result_size) {
  CefRefPtr<CefValue> root = CefParseJSON(result, result_size, JSON_PARSER_RFC);
  if (!root || root->GetType() != VTYPE_DICTIONARY) return std::nullopt;
  CefRefPtr<CefDictionaryValue> runtime = root->GetDictionary()->GetDictionary("result");
  if (!runtime || runtime->GetType("value") != VTYPE_BOOL) return std::nullopt;
  return runtime->GetBool("value");
}

class HostSmokeTest final : public CefDevToolsMessageObserver {
 public:
  HostSmokeTest(CefRefPtr<PageManager> page_manager,
                CefRefPtr<CefWindow> root_window,
                std::function<void(bool, std::string)> completion)
      : page_manager_(std::move(page_manager)),
        root_window_(std::move(root_window)),
        completion_(std::move(completion)) {}

  void Start() {
    one_ = page_manager_->BrowserForPage("one");
    two_ = page_manager_->BrowserForPage("two");
    if (!one_ || !two_) return Finish(false, "smoke: missing fixture browsers");
    one_registration_ = one_->GetHost()->AddDevToolsMessageObserver(this);
    two_registration_ = two_->GetHost()->AddDevToolsMessageObserver(this);
    if (!one_registration_ || !two_registration_) return Finish(false, "smoke: DevTools observer registration failed");
    PollReadiness();
    CefPostDelayedTask(TID_UI, base::BindOnce(&HostSmokeTest::Timeout, CefRefPtr<HostSmokeTest>(this)), kSmokeTimeoutMs);
  }

  void OnDevToolsMethodResult(CefRefPtr<CefBrowser>,
                              int message_id,
                              bool success,
                              const void* result,
                              size_t result_size) override {
    if (finished_) return;
    const auto pending = pending_.find(message_id);
    if (pending == pending_.end()) return;
    const std::string label = pending->second;
    pending_.erase(pending);
    if (!success) return Finish(false, "smoke: Runtime.evaluate failed for " + label);
    if (label == "popup-requested") {
      const std::optional<bool> popup_requested = ReadRuntimeBoolean(result, result_size);
      if (!popup_requested || !*popup_requested)
        return Finish(false, "smoke: local popup request was rejected");
      return Finish(true, report_ + " popup=requested");
    }
    const std::optional<FixtureSnapshot> snapshot = ReadRuntimeSnapshot(result, result_size);
    if (!snapshot) return Finish(false, "smoke: invalid Runtime.evaluate result for " + label);
    results_[label] = *snapshot;
    if (label == "ready-one" || label == "ready-two") {
      if (results_.find("ready-one") == results_.end() || results_.find("ready-two") == results_.end())
        return;
      const FixtureSnapshot& ready_one = results_["ready-one"];
      const FixtureSnapshot& ready_two = results_["ready-two"];
      if (Ready(ready_one) && Ready(ready_two)) {
        Evaluate(one_, "initial-one", RuntimeExpression("one-smoke", true));
        Evaluate(two_, "initial-two", RuntimeExpression("two-smoke", true));
      } else {
        results_.erase("ready-one");
        results_.erase("ready-two");
        CefPostDelayedTask(TID_UI, base::BindOnce(&HostSmokeTest::PollReadiness, CefRefPtr<HostSmokeTest>(this)), 150);
      }
      return;
    }
    if (label == "initial-one" || label == "initial-two") {
      if (results_.find("initial-one") != results_.end() &&
          results_.find("initial-two") != results_.end() && !transitioning_) {
        transitioning_ = true;
        PostTransition();
      }
      return;
    }
    if (results_.find("final-one") != results_.end() &&
        results_.find("final-two") != results_.end()) {
      if (lifecycle_complete_) {
        Verify();
      } else if (!lifecycle_started_) {
        lifecycle_started_ = true;
        StartLifecycleRound();
      }
    }
  }

 private:
  void Evaluate(CefRefPtr<CefBrowser> browser,
                const std::string& label,
                const std::string& expression,
                bool user_gesture = false) {
    CefRefPtr<CefDictionaryValue> parameters = CefDictionaryValue::Create();
    parameters->SetString("expression", expression);
    parameters->SetBool("returnByValue", true);
    if (user_gesture) parameters->SetBool("userGesture", true);
    const int message_id = next_message_id_++;
    const int submitted = browser->GetHost()->ExecuteDevToolsMethod(message_id, "Runtime.evaluate", parameters);
    if (submitted != message_id) return Finish(false, "smoke: Runtime.evaluate submission failed for " + label);
    pending_.emplace(message_id, label);
  }

  static bool Ready(const FixtureSnapshot& snapshot) {
    return !snapshot.nonce.empty() && snapshot.extension.find("worker count") != std::string::npos;
  }

  void PollReadiness() {
    if (finished_) return;
    Evaluate(one_, "ready-one", RuntimeExpression("", false));
    Evaluate(two_, "ready-two", RuntimeExpression("", false));
  }

  void PostTransition() {
    CefPostTask(TID_UI, base::BindOnce(&HostSmokeTest::Transition, CefRefPtr<HostSmokeTest>(this)));
  }

  void Transition() {
    if (finished_) return;
    const CefRect root_bounds = root_window_->GetClientAreaBoundsInScreen();
    const int content_width = root_bounds.width - kSidebarWidth;
    if (content_width < 2 || root_bounds.height < 1)
      return Finish(false, "smoke: root content bounds are too small for viewport checks");
    const int phase = transitions_++ % 3;
    std::vector<PageViewport> viewports;
    if (phase == 0) viewports.push_back({"one", CefRect(kSidebarWidth, 0, content_width, root_bounds.height)});
    if (phase == 1) viewports.push_back({"two", CefRect(kSidebarWidth, 0, content_width, root_bounds.height)});
    if (phase == 2) {
      const int left_width = content_width / 2;
      viewports.push_back({"one", CefRect(kSidebarWidth, 0, left_width, root_bounds.height)});
      viewports.push_back({"two", CefRect(kSidebarWidth + left_width, 0, content_width - left_width, root_bounds.height)});
    }
    if (!page_manager_->SetViewports(viewports)) return Finish(false, "smoke: viewport transition rejected");
    if (transitions_ < kViewportTransitions) return PostTransition();
    Evaluate(one_, "final-one", RuntimeExpression("one-smoke", false));
    Evaluate(two_, "final-two", RuntimeExpression("two-smoke", false));
  }

  // Reusing this ID verifies that the manager rejects creation while a close
  // record drains, and accepts it only once BrowserForPage no longer exposes it.
  void StartLifecycleRound() {
    if (finished_) return;
    if (!page_manager_->Open(kEphemeralPageId, kFixtureOneUrl))
      return Finish(false, "smoke: ephemeral page did not open after drain");
    CefPostTask(TID_UI,
                base::BindOnce(&HostSmokeTest::WaitForEphemeralBrowser,
                               CefRefPtr<HostSmokeTest>(this)));
  }

  void WaitForEphemeralBrowser() {
    if (finished_) return;
    CefRefPtr<CefBrowser> browser = page_manager_->BrowserForPage(kEphemeralPageId);
    if (!browser) {
      CefPostDelayedTask(TID_UI,
                         base::BindOnce(&HostSmokeTest::WaitForEphemeralBrowser,
                                        CefRefPtr<HostSmokeTest>(this)),
                         25);
      return;
    }
    const PageCloseResult result = page_manager_->Close(kEphemeralPageId);
    if (result != PageCloseResult::kRequested)
      return Finish(false, "smoke: ephemeral close request was rejected");
    if (page_manager_->Open(kEphemeralPageId, kFixtureOneUrl))
      return Finish(false, "smoke: ephemeral ID reopened before close drain");
    CefPostDelayedTask(TID_UI,
                       base::BindOnce(&HostSmokeTest::WaitForEphemeralDrain,
                                      CefRefPtr<HostSmokeTest>(this)),
                       25);
  }

  void WaitForEphemeralDrain() {
    if (finished_) return;
    if (page_manager_->BrowserForPage(kEphemeralPageId) ||
        page_manager_->Close(kEphemeralPageId) != PageCloseResult::kNotFound) {
      CefPostDelayedTask(TID_UI,
                         base::BindOnce(&HostSmokeTest::WaitForEphemeralDrain,
                                        CefRefPtr<HostSmokeTest>(this)),
                         25);
      return;
    }
    ++lifecycle_rounds_;
    if (lifecycle_rounds_ == kLifecycleRounds) {
      lifecycle_complete_ = true;
      // Re-read after every ephemeral close drain; these values prove the
      // original documents survived the full lifecycle test as well.
      results_.erase("final-one");
      results_.erase("final-two");
      Evaluate(one_, "final-one", RuntimeExpression("one-smoke", false));
      Evaluate(two_, "final-two", RuntimeExpression("two-smoke", false));
      return;
    }
    // kNotFound above proves final record teardown, unlike a null browser alone.
    StartLifecycleRound();
  }

  void Verify() {
    const FixtureSnapshot& initial_one = results_["initial-one"];
    const FixtureSnapshot& initial_two = results_["initial-two"];
    const FixtureSnapshot& final_one = results_["final-one"];
    const FixtureSnapshot& final_two = results_["final-two"];
    const bool pages_preserved = initial_one.nonce == final_one.nonce &&
                                 initial_two.nonce == final_two.nonce &&
                                 initial_one.nonce != initial_two.nonce &&
                                 final_one.nonce != final_two.nonce &&
                                 final_one.input == "one-smoke" && final_two.input == "two-smoke" &&
                                 final_one.counter == "1" && final_two.counter == "2" &&
                                 !final_one.nonce.empty() && !final_two.nonce.empty();
    const bool extension_present = Ready(final_one) && Ready(final_two);
    std::ostringstream report;
    report << "smoke: transitions=" << transitions_ << " lifecycle_rounds=" << lifecycle_rounds_
           << " one_nonce=" << final_one.nonce
           << " two_nonce=" << final_two.nonce
           << " extension=" << (extension_present ? "ok" : "missing");
    if (!pages_preserved || !extension_present || lifecycle_rounds_ != kLifecycleRounds)
      return Finish(false, report.str());
    report_ = report.str();
    Evaluate(one_, "popup-requested",
             "Boolean(window.open('http://127.0.0.1:4319/two','hitchhiker-smoke-popup'))",
             true);
  }

  void Timeout() { if (!finished_) Finish(false, "smoke: timed out before all DevTools checks completed"); }
  void Finish(bool passed, std::string report) {
    if (finished_) return;
    CefRefPtr<HostSmokeTest> keep_alive(this);
    finished_ = true;
    pending_.clear();
    one_registration_ = nullptr;
    two_registration_ = nullptr;
    one_ = nullptr;
    two_ = nullptr;
    page_manager_ = nullptr;
    root_window_ = nullptr;
    auto completion = std::move(completion_);
    if (completion) completion(passed, std::move(report));
  }

  CefRefPtr<PageManager> page_manager_;
  CefRefPtr<CefWindow> root_window_;
  CefRefPtr<CefBrowser> one_;
  CefRefPtr<CefBrowser> two_;
  CefRefPtr<CefRegistration> one_registration_;
  CefRefPtr<CefRegistration> two_registration_;
  std::function<void(bool, std::string)> completion_;
  std::map<int, std::string> pending_;
  std::map<std::string, FixtureSnapshot> results_;
  std::string report_;
  int next_message_id_ = 1;
  int transitions_ = 0;
  int lifecycle_rounds_ = 0;
  bool transitioning_ = false;
  bool lifecycle_started_ = false;
  bool lifecycle_complete_ = false;
  bool finished_ = false;

  IMPLEMENT_REFCOUNTING(HostSmokeTest);
  DISALLOW_COPY_AND_ASSIGN(HostSmokeTest);
};

}  // namespace

void RunHostSmokeTest(CefRefPtr<PageManager> page_manager,
                      CefRefPtr<CefWindow> root_window,
                      std::function<void(bool, std::string)> completion) {
  if (!page_manager || !root_window) {
    if (completion) completion(false, "smoke: missing PageManager or root window");
    return;
  }
  CefRefPtr<HostSmokeTest> test = new HostSmokeTest(std::move(page_manager), std::move(root_window), std::move(completion));
  test->Start();
}
