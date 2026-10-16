#include "cart.hpp"

int subtotal(const std::vector<Item>& items) {
    int total = 0;
    for (const auto& item : items) total += item.unit_price * item.quantity;
    return total;
}

// Take a percentage off a total. A discount of 100 percent or more makes the order free.
int apply_discount(int total, int percent) {
    if (percent >= 100) return 0;
    return total - total * percent / 100;
}
