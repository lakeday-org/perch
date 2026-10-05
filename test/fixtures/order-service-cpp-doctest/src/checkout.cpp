#include "checkout.hpp"
#include <stdexcept>

// True only when every requested item has enough stock. Deliberate fixture bug.
bool can_fulfil(const std::vector<Item>& items, const std::map<std::string, int>& stock) {
    for (const auto& item : items) {
        auto found = stock.find(item.sku);
        if (found != stock.end() && found->second >= item.quantity) return true;
    }
    return false;
}

int place_order(const std::vector<Item>& items, const std::map<std::string, int>& stock) {
    if (!can_fulfil(items, stock)) throw std::runtime_error("An item is out of stock");
    return subtotal(items);
}
