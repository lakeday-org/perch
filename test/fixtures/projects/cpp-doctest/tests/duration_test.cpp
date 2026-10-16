#include <doctest/doctest.h>

#include "throttle/duration.hpp"

using throttle::Millis;

TEST_SUITE("duration") {
  TEST_CASE("parse_duration reads each unit") {
    SUBCASE("milliseconds") { CHECK(throttle::parse_duration("250ms") == Millis{250}); }
    SUBCASE("seconds") { CHECK(throttle::parse_duration("30s") == Millis{30000}); }
    SUBCASE("minutes") { CHECK(throttle::parse_duration("2m") == Millis{120000}); }
    SUBCASE("hours") { CHECK(throttle::parse_duration("1h") == Millis{3600000}); }
  }

  TEST_CASE("parse_duration adds the parts of a compound duration") {
    CHECK(throttle::parse_duration("1m30s") == Millis{90000});
    CHECK(throttle::parse_duration("1h0m5s250ms") == Millis{3605250});
  }

  TEST_CASE("parse_duration rejects malformed text") {
    for (const char* text : {"", "ms", "10", "10x", "30s1m", "5s5s"}) {
      CAPTURE(text);
      CHECK_THROWS_AS(throttle::parse_duration(text), throttle::DurationError);
    }
  }

  TEST_CASE("format_duration writes the shortest form") {
    CHECK(throttle::format_duration(Millis{90000}) == "1m30s");
    CHECK(throttle::format_duration(Millis{0}) == "0ms");
  }

  TEST_CASE("format_duration leaves out the units that are zero") {
    CHECK(throttle::format_duration(Millis{3600000}) == "1h");
    CHECK(throttle::format_duration(Millis{3600250}) == "1h250ms");
  }

  TEST_CASE("format_duration reads back through parse_duration") {
    const Millis duration{3725004};
    CHECK(throttle::parse_duration(throttle::format_duration(duration)) == duration);
  }
}
