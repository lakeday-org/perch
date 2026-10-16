#include "stockroom/reorder.hpp"

#include <cmath>
#include <stdexcept>

namespace stockroom {

int reorder_quantity(const ReorderRule& rule, int on_hand, double daily_demand) {
  switch (rule.policy) {
    case ReorderPolicy::Never:
      return 0;
    case ReorderPolicy::FixedQuantity:
      return on_hand <= rule.point ? rule.quantity : 0;
    case ReorderPolicy::TopUpToMax:
      return on_hand <= rule.point ? rule.maximum - on_hand : 0;
    case ReorderPolicy::LeadTimeDemand: {
      const int needed = static_cast<int>(std::ceil(daily_demand * rule.lead_days)) + rule.safety;
      return on_hand < needed ? needed - on_hand : 0;
    }
  }
  return 0;
}

int round_to_case(int quantity, int case_size) {
  if (case_size <= 0) {
    throw std::invalid_argument("a case holds at least one unit");
  }
  if (quantity <= 0) {
    return 0;
  }
  return (quantity + case_size - 1) / case_size * case_size;
}

}  // namespace stockroom
