#include <catch2/catch_test_macros.hpp>
#include <catch2/generators/catch_generators.hpp>

#include <stdexcept>
#include <tuple>

#include "stockroom/reorder.hpp"

using stockroom::ReorderPolicy;
using stockroom::ReorderRule;

TEST_CASE("reorder_quantity follows the policy", "[reorder]") {
  ReorderRule rule;
  rule.point = 10;
  rule.quantity = 40;
  rule.maximum = 60;
  rule.lead_days = 5;
  rule.safety = 8;

  auto [policy, on_hand, demand, expected] = GENERATE(table<ReorderPolicy, int, double, int>({
      {ReorderPolicy::Never, 0, 3.0, 0},
      {ReorderPolicy::FixedQuantity, 10, 3.0, 40},
      {ReorderPolicy::FixedQuantity, 11, 3.0, 0},
      {ReorderPolicy::TopUpToMax, 4, 3.0, 56},
      {ReorderPolicy::LeadTimeDemand, 20, 3.2, 4},
  }));
  rule.policy = policy;
  CAPTURE(static_cast<int>(policy), on_hand, demand);
  CHECK(stockroom::reorder_quantity(rule, on_hand, demand) == expected);
}

TEST_CASE("lead-time demand rounds part of a unit up", "[reorder]") {
  ReorderRule rule;
  rule.policy = ReorderPolicy::LeadTimeDemand;
  rule.lead_days = 3;
  CHECK(stockroom::reorder_quantity(rule, 0, 0.5) == 2);
}

TEST_CASE("round_to_case", "[reorder]") {
  SECTION("rounds up to whole cases") {
    CHECK(stockroom::round_to_case(13, 12) == 24);
    CHECK(stockroom::round_to_case(12, 12) == 12);
  }
  SECTION("orders nothing for nothing") {
    CHECK(stockroom::round_to_case(0, 12) == 0);
  }
  SECTION("refuses an empty case") {
    CHECK_THROWS_AS(stockroom::round_to_case(5, 0), std::invalid_argument);
  }
}

// Suppliers ship six to a case at minimum; this asks for less.
TEST_CASE("round_to_case never orders less than a supplier's minimum case", "[reorder]") {
  CHECK(stockroom::round_to_case(1, 4) == 6);
}
