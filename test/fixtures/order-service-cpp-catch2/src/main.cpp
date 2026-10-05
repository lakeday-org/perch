#include "checkout.hpp"
#include <iostream>

int main() {
    std::vector<Item> items = {{"book", 1, 20}, {"pen", 2, 3}};
    std::map<std::string, int> stock = {{"book", 4}, {"pen", 0}};
    std::cout << "Accepted order total: " << place_order(items, stock) << '\n';
}
