#include <doctest/doctest.h>

#include <string>

#include "throttle/policy.hpp"

using throttle::Decision;
using throttle::Strategy;

TEST_CASE("decide") {
  SUBCASE("allows anything within the limit") {
    CHECK(throttle::decide(Strategy::Drop, true, 0, 0) == Decision::Allow);
  }
  SUBCASE("Drop rejects over the limit") {
    CHECK(throttle::decide(Strategy::Drop, false, 0, 10) == Decision::Reject);
  }
  SUBCASE("Queue delays while the queue has room") {
    CHECK(throttle::decide(Strategy::Queue, false, 9, 10) == Decision::Delay);
    CHECK(throttle::decide(Strategy::Queue, false, 10, 10) == Decision::Reject);
  }
  SUBCASE("Shed lets it through marked") {
    CHECK(throttle::decide(Strategy::Shed, false, 0, 0) == Decision::AllowShed);
  }
}

TEST_CASE("decision_name names every decision") {
  CHECK(std::string(throttle::decision_name(Decision::Allow)) == "allow");
  CHECK(std::string(throttle::decision_name(Decision::AllowShed)) == "allow-shed");
}

TEST_CASE("decide treats a queue with no room as full") {
  CHECK(throttle::decide(Strategy::Queue, false, 0, 0) == Decision::Reject);
}
