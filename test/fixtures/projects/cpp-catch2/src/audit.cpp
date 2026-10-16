#include "stockroom/audit.hpp"

#include <algorithm>
#include <cstdlib>
#include <sstream>

namespace stockroom {

std::vector<Discrepancy> compare_count(const Inventory& inventory, const std::map<Sku, int>& counted) {
  std::vector<Discrepancy> found;
  for (const auto& [sku, lines] : inventory.bins()) {
    const int expected = inventory.on_hand(sku);
    const auto it = counted.find(sku);
    const int seen = it == counted.end() ? 0 : it->second;
    if (seen != expected) {
      found.push_back(Discrepancy{sku, expected, seen});
    }
  }
  std::sort(found.begin(), found.end(), [](const Discrepancy& a, const Discrepancy& b) {
    return std::abs(a.expected - a.counted) > std::abs(b.expected - b.counted);
  });
  return found;
}

std::string audit_report(const std::vector<Discrepancy>& found) {
  if (found.empty()) {
    return "count matches\n";
  }
  std::ostringstream out;
  for (const auto& item : found) {
    out << item.sku.code() << ": expected " << item.expected << ", counted " << item.counted << '\n';
  }
  return out.str();
}

}  // namespace stockroom
