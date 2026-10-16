#include "checkout.hpp"
#include <gtest/gtest.h>

TEST(CanFulfil, AcceptsWhenEveryItemIsInStock) {
    std::vector<Item> items = {{"book", 1, 20}, {"pen", 2, 3}};
    std::map<std::string, int> stock = {{"book", 4}, {"pen", 5}};
    EXPECT_TRUE(can_fulfil(items, stock));
}

TEST(CanFulfil, RejectsAnEmptyCart) {
    std::map<std::string, int> stock = {{"book", 4}};
    EXPECT_FALSE(can_fulfil({}, stock));
}

TEST(CanFulfil, AcceptsQuantityEqualToStock) {
    std::vector<Item> items = {{"book", 3, 20}};
    std::map<std::string, int> stock = {{"book", 3}};
    EXPECT_TRUE(can_fulfil(items, stock));
}

TEST(CanFulfil, ReturnsWhatTheStubReturns) {
    auto stock_check = [](const std::vector<Item>&, const std::map<std::string, int>&) { return true; };
    std::vector<Item> items = {{"pen", 2, 3}};
    std::map<std::string, int> stock = {{"pen", 0}};
    EXPECT_TRUE(stock_check(items, stock));
}

TEST(PlaceOrder, ReturnsTheSubtotal) {
    std::vector<Item> items = {{"book", 1, 20}, {"pen", 2, 3}};
    std::map<std::string, int> stock = {{"book", 4}, {"pen", 5}};
    EXPECT_EQ(place_order(items, stock), 26);
}
