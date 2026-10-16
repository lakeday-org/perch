#pragma once

#include <cstddef>
#include <string>

#include "throttle/clock.hpp"
#include "throttle/lru_cache.hpp"
#include "throttle/policy.hpp"
#include "throttle/token_bucket.hpp"

namespace throttle {

struct LimiterConfig {
  double burst = 10;
  double per_second = 5;
  Strategy strategy = Strategy::Drop;
  std::size_t max_queue = 0;
  std::size_t max_keys = 10000;
};

// One token bucket per client key, the least recently seen keys forgotten first.
class Limiter {
 public:
  Limiter(LimiterConfig config, const Clock& clock);

  Decision admit(const std::string& key);
  std::size_t tracked() const { return buckets_.size(); }

  // Requests a Delay decision put in the queue, taken back out as they are sent.
  void dequeue();

 private:
  LimiterConfig config_;
  const Clock& clock_;
  LruCache<std::string, TokenBucket> buckets_;
  std::size_t queued_ = 0;
};

}  // namespace throttle
