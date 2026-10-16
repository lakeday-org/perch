#include <doctest/doctest.h>

#include <stdexcept>

#include "throttle/limiter.hpp"

using namespace throttle;

namespace {

LimiterConfig tight(Strategy strategy) {
  LimiterConfig config;
  config.burst = 1;
  config.per_second = 1;
  config.strategy = strategy;
  config.max_queue = 1;
  config.max_keys = 2;
  return config;
}

}  // namespace

TEST_CASE("Limiter keeps a bucket for each key") {
  ManualClock clock;
  Limiter limiter(tight(Strategy::Drop), clock);
  CHECK(limiter.admit("10.0.0.1") == Decision::Allow);
  CHECK(limiter.admit("10.0.0.2") == Decision::Allow);
  CHECK(limiter.admit("10.0.0.1") == Decision::Reject);
  CHECK(limiter.tracked() == 2);
}

TEST_CASE("Limiter queues one request with the Queue strategy") {
  ManualClock clock;
  Limiter limiter(tight(Strategy::Queue), clock);
  REQUIRE(limiter.admit("client") == Decision::Allow);
  CHECK(limiter.admit("client") == Decision::Delay);
  CHECK(limiter.admit("client") == Decision::Reject);
  limiter.dequeue();
  CHECK(limiter.admit("client") == Decision::Delay);
}

TEST_CASE("Limiter refuses to dequeue from an empty queue") {
  ManualClock clock;
  Limiter limiter(tight(Strategy::Queue), clock);
  CHECK_THROWS_AS(limiter.dequeue(), std::logic_error);
}

// A key seen again after a minute should start with a full bucket. The bucket refills instead, which is the same only when
// burst / per_second is under a minute.
TEST_CASE("Limiter starts a key idle for a minute with a full burst") {
  ManualClock clock;
  LimiterConfig config = tight(Strategy::Drop);
  config.burst = 100;
  config.per_second = 1;
  Limiter limiter(config, clock);
  for (int i = 0; i < 100; ++i) limiter.admit("client");
  clock.advance(Millis{60000});
  int allowed = 0;
  while (limiter.admit("client") == Decision::Allow) ++allowed;
  CHECK(allowed == 100);
}
