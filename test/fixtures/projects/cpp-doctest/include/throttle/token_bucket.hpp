#pragma once

#include "throttle/clock.hpp"

namespace throttle {

// Holds up to `capacity` tokens and gains `per_second` of them a second. A request spends one token or more.
class TokenBucket {
 public:
  TokenBucket(double capacity, double per_second, const Clock& clock);

  bool try_acquire(double tokens = 1.0);
  double available();

  // How long until `tokens` would be available, zero when they are now.
  Millis time_until(double tokens);

 private:
  void refill();

  double capacity_;
  double per_second_;
  double tokens_;
  const Clock& clock_;
  Millis last_;
};

}  // namespace throttle
