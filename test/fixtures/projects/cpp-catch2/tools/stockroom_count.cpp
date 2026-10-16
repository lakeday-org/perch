// stockroom-count: loads a goods-in CSV, reads a cycle count from a second, and prints what does not match.
//
//   stockroom-count receipts.csv count.csv
#include <fstream>
#include <iostream>
#include <map>
#include <string>

#include "stockroom/audit.hpp"
#include "stockroom/csv.hpp"

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "usage: stockroom-count receipts.csv count.csv\n";
    return 2;
  }
  stockroom::Inventory inventory;
  std::ifstream receipts(argv[1]);
  for (std::string line; std::getline(receipts, line);) {
    const auto receipt = stockroom::parse_receipt(line);
    inventory.receive(receipt.sku, receipt.quantity, receipt.bin);
  }
  std::map<stockroom::Sku, int> counted;
  std::ifstream count(argv[2]);
  for (std::string line; std::getline(count, line);) {
    const auto fields = stockroom::split_csv_line(line);
    counted[stockroom::Sku(fields.at(0))] += std::stoi(fields.at(1));
  }
  std::cout << stockroom::audit_report(stockroom::compare_count(inventory, counted));
  return 0;
}
