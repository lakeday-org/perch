#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include <stdexcept>
#include <string>
#include <vector>

#include "stockroom/csv.hpp"

TEST_CASE("split_csv_line", "[csv]") {
  using Fields = std::vector<std::string>;
  SECTION("splits on commas") {
    CHECK(stockroom::split_csv_line("a,b,,c") == Fields{"a", "b", "", "c"});
  }
  SECTION("keeps commas inside quotes") {
    CHECK(stockroom::split_csv_line(R"(BLT-0042,"bolts, M6",12)") == Fields{"BLT-0042", "bolts, M6", "12"});
  }
  SECTION("reads a doubled quote as one") {
    CHECK(stockroom::split_csv_line(R"("12"" pipe")") == Fields{"12\" pipe"});
  }
  SECTION("refuses an unterminated quote") {
    CHECK_THROWS_AS(stockroom::split_csv_line(R"("open)"), std::invalid_argument);
  }
}

TEST_CASE("parse_receipt reads a goods-in line", "[csv]") {
  const auto receipt = stockroom::parse_receipt("blt-0042,12,C-04-17");
  CHECK(receipt.sku.code() == "BLT-0042");
  CHECK(receipt.quantity == 12);
  CHECK(receipt.bin == stockroom::BinLocation{'C', 4, 17});
}

TEST_CASE("parse_receipt names the field it could not read", "[csv]") {
  CHECK_THROWS_WITH(stockroom::parse_receipt("BLT-0042,12,dock"), "not a bin: dock");
}
