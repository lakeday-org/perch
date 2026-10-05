#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <stdexcept>

#include "stockroom/ring_buffer.hpp"

using stockroom::RingBuffer;

TEST_CASE("RingBuffer keeps the last N values", "[ring]") {
  RingBuffer<int, 3> sales;
  for (int day : {5, 8, 2, 9}) sales.push(day);
  CHECK(sales.full());
  CHECK(sales.size() == 3);
  CHECK(sales.at(0) == 8);
  CHECK(sales.at(2) == 9);
}

TEST_CASE("RingBuffer averages what it holds", "[ring]") {
  RingBuffer<double, 4> demand;
  CHECK(demand.mean() == 0.0);
  demand.push(1.5);
  demand.push(2.5);
  CHECK_THAT(demand.mean(), Catch::Matchers::WithinAbs(2.0, 1e-9));
}

TEST_CASE("RingBuffer refuses an index past its size", "[ring]") {
  RingBuffer<int, 2> empty;
  CHECK_THROWS_AS(empty.at(0), std::out_of_range);
}
