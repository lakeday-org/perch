#include <catch2/catch_test_macros.hpp>

#include "stockroom/inventory.hpp"

using namespace stockroom;

namespace {

struct StockedShelf {
  StockedShelf() {
    inventory.receive(bolts, 30, BinLocation{'A', 1, 5});
    inventory.receive(bolts, 20, BinLocation{'C', 2, 9});
  }

  Inventory inventory;
  const Sku bolts{"BLT-0042"};
  const BinLocation dock{'A', 1, 1};
};

}  // namespace

TEST_CASE("receive adds to a bin that already holds the SKU", "[inventory]") {
  Inventory inventory;
  const Sku nuts("NUT-0007");
  inventory.receive(nuts, 5, BinLocation{'B', 2, 3});
  inventory.receive(nuts, 7, BinLocation{'B', 2, 3});
  CHECK(inventory.on_hand(nuts) == 12);
  CHECK(inventory.bins().at(nuts).size() == 1);
}

TEST_CASE("receive refuses a quantity that is not positive", "[inventory]") {
  Inventory inventory;
  CHECK_THROWS_AS(inventory.receive(Sku("NUT-0007"), 0, BinLocation{'B', 2, 3}), StockError);
}

TEST_CASE_METHOD(StockedShelf, "reserve holds stock against an order", "[inventory]") {
  SECTION("within what is available") {
    REQUIRE(inventory.reserve(bolts, 45));
    CHECK(inventory.available(bolts) == 5);
  }
  SECTION("beyond what is available holds nothing") {
    CHECK_FALSE(inventory.reserve(bolts, 51));
    CHECK(inventory.reserved(bolts) == 0);
  }
  SECTION("released stock is available again") {
    REQUIRE(inventory.reserve(bolts, 10));
    inventory.release(bolts, 10);
    CHECK(inventory.available(bolts) == 50);
  }
}

TEST_CASE_METHOD(StockedShelf, "pick takes from the nearest bin first", "[inventory]") {
  REQUIRE(inventory.reserve(bolts, 35));
  const auto lines = inventory.pick(bolts, 35, dock);
  REQUIRE(lines.size() == 2);
  CHECK(lines[0].bin == BinLocation{'A', 1, 5});
  CHECK(lines[0].quantity == 30);
  CHECK(lines[1].quantity == 5);
  CHECK(inventory.on_hand(bolts) == 15);
}

TEST_CASE_METHOD(StockedShelf, "pick refuses stock nobody reserved", "[inventory]") {
  CHECK_THROWS_AS(inventory.pick(bolts, 1, dock), StockError);
}

TEST_CASE("release refuses more than was reserved", "[inventory]") {
  Inventory inventory;
  CHECK_THROWS_AS(inventory.release(Sku("NUT-0007"), 1), StockError);
}

TEST_CASE("on_hand is zero for a SKU never received", "[inventory]") {
  const Inventory inventory;
  CHECK(inventory.on_hand(Sku("ZZZ-9999")) == 0);
}

TEST_CASE("a million receipts into one bin", "[.][slow][inventory]") {
  Inventory inventory;
  const Sku bolts("BLT-0042");
  for (int i = 0; i < 1'000'000; ++i) inventory.receive(bolts, 1, BinLocation{'A', 1, 1});
  CHECK(inventory.on_hand(bolts) == 1'000'000);
}
