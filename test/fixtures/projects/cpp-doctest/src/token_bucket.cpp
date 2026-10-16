#include "throttle/token_bucket.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace throttle {

TokenBucket::TokenBucket(double capacity, double per_second, const Clock& clock)
    : capacity_(capacity), per_second_(per_second), tokens_(capacity), clock_(clock), last_(clock.now()) {
  if (capacity <= 0 || per_second <= 0) {
    throw std::invalid_argument("a bucket needs a positive capacity and refill rate");
  }
}

void TokenBucket::refill() {
  const Millis now = clock_.now();
  const double elapsed = static_cast<double>((now - last_).count()) / 1000.0;
  tokens_ = std::min(capacity_, tokens_ + elapsed * per_second_);
  last_ = now;
}

bool TokenBucket::try_acquire(double tokens) {
  refill();
  if (tokens > tokens_) {
    return false;
  }
  tokens_ -= tokens;
  return true;
}

double TokenBucket::available() {
  refill();
  return tokens_;
}

Millis TokenBucket::time_until(double tokens) {
  refill();
  if (tokens > capacity_) {
    throw std::invalid_argument("asking for more than the bucket holds");
  }
  if (tokens <= tokens_) {
    return Millis{0};
  }
  return Millis{static_cast<Millis::rep>(std::ceil((tokens - tokens_) / per_second_ * 1000.0))};
}

}  // namespace throttle
