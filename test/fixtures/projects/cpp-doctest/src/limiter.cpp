#include "throttle/limiter.hpp"

#include <stdexcept>
#include <utility>

namespace throttle {

Limiter::Limiter(LimiterConfig config, const Clock& clock)
    : config_(std::move(config)), clock_(clock), buckets_(config_.max_keys) {}

Decision Limiter::admit(const std::string& key) {
  TokenBucket& bucket = buckets_.get_or_create(key, [this] { return TokenBucket(config_.burst, config_.per_second, clock_); });
  const Decision decision = decide(config_.strategy, bucket.try_acquire(), queued_, config_.max_queue);
  if (decision == Decision::Delay) {
    ++queued_;
  }
  return decision;
}

void Limiter::dequeue() {
  if (queued_ == 0) {
    throw std::logic_error("dequeue with nothing queued");
  }
  --queued_;
}

}  // namespace throttle
