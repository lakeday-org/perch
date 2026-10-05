#include <doctest/doctest.h>

#include <stdexcept>

#include "throttle/window.hpp"

using throttle::Millis;
using throttle::SlidingWindow;

TEST_CASE("SlidingWindow admits up to its limit within the span") {
  SlidingWindow window(3, Millis{1000});
  CHECK(window.admit(Millis{0}));
  CHECK(window.admit(Millis{100}));
  CHECK(window.admit(Millis{200}));
  CHECK_FALSE(window.admit(Millis{300}));
}

TEST_CASE("SlidingWindow lets events expire after the span") {
  SlidingWindow window(1, Millis{1000});
  REQUIRE(window.admit(Millis{0}));
  CHECK_FALSE(window.admit(Millis{999}));
  CHECK(window.admit(Millis{1000}));
}

TEST_CASE("SlidingWindow counts without recording") {
  SlidingWindow window(2, Millis{500});
  window.admit(Millis{0});
  CHECK(window.count(Millis{100}) == 1);
  CHECK(window.count(Millis{600}) == 0);
}

TEST_CASE("SlidingWindow needs a limit and a span") {
  CHECK_THROWS_AS(SlidingWindow(0, Millis{1000}), std::invalid_argument);
  CHECK_THROWS_AS(SlidingWindow(1, Millis{0}), std::invalid_argument);
}
