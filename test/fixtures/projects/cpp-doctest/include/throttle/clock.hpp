#pragma once

#include <chrono>

namespace throttle {

using Millis = std::chrono::milliseconds;

// Where the limiter reads the time from, so a test can move it by hand.
class Clock {
 public:
  virtual ~Clock() = default;
  virtual Millis now() const = 0;
};

// The process's monotonic clock.
class SteadyClock : public Clock {
 public:
  Millis now() const override;
};

// A clock that moves only when told to.
class ManualClock : public Clock {
 public:
  explicit ManualClock(Millis start = Millis{0}) : now_(start) {}

  Millis now() const override { return now_; }

  void advance(Millis by) {
    now_ += by;
  }

 private:
  Millis now_;
};

}  // namespace throttle
