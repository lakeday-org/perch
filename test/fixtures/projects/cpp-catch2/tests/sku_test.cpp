#include <catch2/catch_test_macros.hpp>
#include <catch2/generators/catch_generators.hpp>

#include <stdexcept>

#include "stockroom/sku.hpp"

using stockroom::Sku;

TEST_CASE("is_valid_sku accepts three letters, a dash and four digits", "[sku]") {
  CHECK(stockroom::is_valid_sku("BLT-0042"));
}

TEST_CASE("is_valid_sku rejects malformed codes", "[sku]") {
  const auto code = GENERATE("", "BLT0042", "blt-0042", "BL-00420", "BLT-00A2", "BLT-00421");
  CAPTURE(code);
  CHECK_FALSE(stockroom::is_valid_sku(code));
}

TEST_CASE("parse_sku cleans up what a scanner sends", "[sku]") {
  SECTION("surrounding whitespace is trimmed") {
    const auto sku = stockroom::parse_sku("  BLT-0042\n");
    REQUIRE(sku.has_value());
    CHECK(sku->code() == "BLT-0042");
  }
  SECTION("lower case is raised") {
    const auto sku = stockroom::parse_sku("nut-0007");
    REQUIRE(sku.has_value());
    CHECK(sku->code() == "NUT-0007");
  }
  SECTION("garbage is refused") {
    CHECK_FALSE(stockroom::parse_sku("not a sku").has_value());
  }
}

TEST_CASE("Sku splits into a family and a number", "[sku]") {
  const Sku sku("WSH-0310");
  CHECK(sku.family() == "WSH");
  CHECK(sku.number() == 310);
}

TEST_CASE("Sku refuses an invalid code", "[sku]") {
  CHECK_THROWS_AS(Sku("WSH-31"), std::invalid_argument);
}
