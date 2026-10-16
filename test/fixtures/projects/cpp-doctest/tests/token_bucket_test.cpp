#include <doctest/doctest.h>

#include <stdexcept>

#include "throttle/token_bucket.hpp"

using namespace throttle;

struct BucketFixture {
  ManualClock clock;
  TokenBucket bucket{5, 2, clock};
};

TEST_CASE_FIXTURE(BucketFixture, "a full bucket spends its burst and then refuses") {
  for (int i = 0; i < 5; ++i) REQUIRE(bucket.try_acquire());
  CHECK_FALSE(bucket.try_acquire());
}

TEST_CASE_FIXTURE(BucketFixture, "tokens come back at the refill rate") {
  REQUIRE(bucket.try_acquire(5));
  clock.advance(Millis{1500});
  CHECK(bucket.available() == doctest::Approx(3.0));
}

TEST_CASE_FIXTURE(BucketFixture, "the bucket never holds more than its capacity") {
  clock.advance(Millis{60000});
  CHECK(bucket.available() == doctest::Approx(5.0));
}

TEST_CASE_FIXTURE(BucketFixture, "time_until says how long to wait") {
  REQUIRE(bucket.try_acquire(5));
  SUBCASE("for one token") { CHECK(bucket.time_until(1) == Millis{500}); }
  SUBCASE("for none when they are there") {
    clock.advance(Millis{1000});
    CHECK(bucket.time_until(2) == Millis{0});
  }
  SUBCASE("refusing more than the capacity") { CHECK_THROWS_AS(bucket.time_until(6), std::invalid_argument); }
}

TEST_CASE("a bucket needs a positive capacity and rate") {
  ManualClock clock;
  CHECK_THROWS_AS(TokenBucket(0, 1, clock), std::invalid_argument);
  CHECK_THROWS_AS(TokenBucket(1, 0, clock), std::invalid_argument);
}
