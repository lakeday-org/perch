#pragma once
#include <string>
#include <vector>

struct Item {
    std::string sku;
    int quantity;
    int unit_price;
};

int subtotal(const std::vector<Item>& items);
