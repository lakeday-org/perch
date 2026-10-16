#pragma once

#include <map>
#include <stdexcept>
#include <vector>

#include "stockroom/location.hpp"
#include "stockroom/sku.hpp"

namespace stockroom {

class StockError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

struct PickLine {
  BinLocation bin;
  int quantity;
};

// Stock on hand by SKU and bin, with reservations held against it until they are picked or released.
class Inventory {
 public:
  void receive(const Sku& sku, int quantity, const BinLocation& bin);

  // Holds `quantity` for an order. False, and nothing held, when less than that is available.
  bool reserve(const Sku& sku, int quantity);
  void release(const Sku& sku, int quantity);

  // Takes reserved stock out of its bins, nearest `from` first, and says where it came from.
  std::vector<PickLine> pick(const Sku& sku, int quantity, const BinLocation& from);

  int on_hand(const Sku& sku) const;
  int reserved(const Sku& sku) const;
  int available(const Sku& sku) const { return on_hand(sku) - reserved(sku); }

  const std::map<Sku, std::vector<PickLine>>& bins() const { return bins_; }

 private:
  std::map<Sku, std::vector<PickLine>> bins_;
  std::map<Sku, int> reserved_;
};

}  // namespace stockroom
