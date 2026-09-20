#include "cart.hpp"

int subtotal(const std::vector<Item>& items) {
    int total = 0;
    for (const auto& item : items) total += item.unit_price * item.quantity;
    return total;
}
