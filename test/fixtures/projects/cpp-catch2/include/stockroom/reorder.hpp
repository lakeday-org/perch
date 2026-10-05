#pragma once

namespace stockroom {

enum class ReorderPolicy {
  Never,          // discontinued: sell through, never buy more
  FixedQuantity,  // order `quantity` whenever stock falls to `point`
  TopUpToMax,     // order back up to `maximum`
  LeadTimeDemand  // order what the lead time will consume, plus safety stock
};

struct ReorderRule {
  ReorderPolicy policy = ReorderPolicy::FixedQuantity;
  int point = 0;
  int quantity = 0;
  int maximum = 0;
  int lead_days = 0;
  int safety = 0;
};

// How many to order now, given what is on hand and how much sells a day. Zero when nothing is due.
int reorder_quantity(const ReorderRule& rule, int on_hand, double daily_demand);

// Rounds an order up to whole cases.
int round_to_case(int quantity, int case_size);

}  // namespace stockroom
