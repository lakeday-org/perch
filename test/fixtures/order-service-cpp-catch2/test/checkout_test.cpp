#include "checkout.hpp"
#include <catch2/catch_test_macros.hpp>

TEST_CASE("can_fulfil accepts when every item is in stock", "[can_fulfil]") {
    std::vector<Item> items = {{"book", 1, 20}, {"pen", 2, 3}};
    std::map<std::string, int> stock = {{"book", 4}, {"pen", 5}};
    CHECK(can_fulfil(items, stock));
}

TEST_CASE("can_fulfil rejects an empty cart", "[can_fulfil]") {
    std::map<std::string, int> stock = {{"book", 4}};
    CHECK_FALSE(can_fulfil({}, stock));
}

TEST_CASE("can_fulfil accepts a quantity equal to the stock", "[can_fulfil]") {
    std::vector<Item> items = {{"book", 3, 20}};
    std::map<std::string, int> stock = {{"book", 3}};
    CHECK(can_fulfil(items, stock));
}

TEST_CASE("can_fulfil returns what the stub returns", "[can_fulfil]") {
    auto stock_check = [](const std::vector<Item>&, const std::map<std::string, int>&) { return true; };
    std::vector<Item> items = {{"pen", 2, 3}};
    std::map<std::string, int> stock = {{"pen", 0}};
    CHECK(stock_check(items, stock));
}

TEST_CASE("place_order returns the subtotal", "[place_order]") {
    std::vector<Item> items = {{"book", 1, 20}, {"pen", 2, 3}};
    std::map<std::string, int> stock = {{"book", 4}, {"pen", 5}};
    CHECK(place_order(items, stock) == 26);
}
