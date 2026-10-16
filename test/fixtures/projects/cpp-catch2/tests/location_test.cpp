#include <catch2/catch_test_macros.hpp>
#include <catch2/generators/catch_generators.hpp>

#include "stockroom/location.hpp"

using stockroom::BinLocation;

TEST_CASE("parse_location reads aisle, shelf and slot", "[location]") {
  const auto bin = stockroom::parse_location("C-04-17");
  REQUIRE(bin.has_value());
  CHECK(bin->aisle == 'C');
  CHECK(bin->shelf == 4);
  CHECK(bin->slot == 17);
}

TEST_CASE("parse_location rejects what is not a bin", "[location]") {
  auto text = GENERATE("C-4-17", "c-04-17", "C-00-17", "C-04-1x", "C/04/17");
  CAPTURE(text);
  CHECK_FALSE(stockroom::parse_location(text).has_value());
}

TEST_CASE("format_location pads shelf and slot", "[location]") {
  CHECK(stockroom::format_location(BinLocation{'A', 1, 2}) == "A-01-02");
}

TEST_CASE("walk_distance", "[location]") {
  const BinLocation here{'B', 3, 10};
  SECTION("within an aisle is the slots between") {
    CHECK(stockroom::walk_distance(here, BinLocation{'B', 1, 4}) == 6);
  }
  SECTION("across aisles goes by the cross aisle") {
    CHECK(stockroom::walk_distance(here, BinLocation{'D', 1, 4}) == 34);
  }
}
