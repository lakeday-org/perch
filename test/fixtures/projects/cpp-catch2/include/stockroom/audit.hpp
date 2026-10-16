#pragma once

#include <map>
#include <string>
#include <vector>

#include "stockroom/inventory.hpp"

namespace stockroom {

struct Discrepancy {
  Sku sku;
  int expected;
  int counted;
};

// What a cycle count found that the system did not expect, largest difference first.
std::vector<Discrepancy> compare_count(const Inventory& inventory, const std::map<Sku, int>& counted);

std::string audit_report(const std::vector<Discrepancy>& found);

}  // namespace stockroom
