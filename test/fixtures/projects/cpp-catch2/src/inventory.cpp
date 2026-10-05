#include "stockroom/inventory.hpp"

#include <algorithm>
#include <numeric>

namespace stockroom {

void Inventory::receive(const Sku& sku, int quantity, const BinLocation& bin) {
  if (quantity <= 0) {
    throw StockError("received quantity must be positive");
  }
  auto& lines = bins_[sku];
  for (auto& line : lines) {
    if (line.bin == bin) {
      line.quantity += quantity;
      return;
    }
  }
  lines.push_back(PickLine{bin, quantity});
}

bool Inventory::reserve(const Sku& sku, int quantity) {
  if (quantity <= 0 || available(sku) < quantity) {
    return false;
  }
  reserved_[sku] += quantity;
  return true;
}

void Inventory::release(const Sku& sku, int quantity) {
  auto it = reserved_.find(sku);
  if (it == reserved_.end() || it->second < quantity) {
    throw StockError("releasing more of " + sku.code() + " than is reserved");
  }
  it->second -= quantity;
  if (it->second == 0) {
    reserved_.erase(it);
  }
}

std::vector<PickLine> Inventory::pick(const Sku& sku, int quantity, const BinLocation& from) {
  if (reserved(sku) < quantity) {
    throw StockError("picking " + std::to_string(quantity) + " of " + sku.code() + " without a reservation");
  }
  auto& lines = bins_[sku];
  std::sort(lines.begin(), lines.end(), [&from](const PickLine& a, const PickLine& b) {
    return walk_distance(from, a.bin) < walk_distance(from, b.bin);
  });
  std::vector<PickLine> picked;
  int left = quantity;
  for (auto& line : lines) {
    if (left == 0) break;
    const int take = std::min(left, line.quantity);
    line.quantity -= take;
    left -= take;
    picked.push_back(PickLine{line.bin, take});
  }
  lines.erase(std::remove_if(lines.begin(), lines.end(), [](const PickLine& line) { return line.quantity == 0; }), lines.end());
  release(sku, quantity);
  return picked;
}

int Inventory::on_hand(const Sku& sku) const {
  auto it = bins_.find(sku);
  if (it == bins_.end()) {
    return 0;
  }
  return std::accumulate(it->second.begin(), it->second.end(), 0, [](int sum, const PickLine& line) { return sum + line.quantity; });
}

int Inventory::reserved(const Sku& sku) const {
  auto it = reserved_.find(sku);
  return it == reserved_.end() ? 0 : it->second;
}

}  // namespace stockroom
