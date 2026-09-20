#pragma once
#include "cart.hpp"
#include <map>

bool can_fulfil(const std::vector<Item>& items, const std::map<std::string, int>& stock);
int place_order(const std::vector<Item>& items, const std::map<std::string, int>& stock);
