#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "stockroom/location.hpp"
#include "stockroom/sku.hpp"

namespace stockroom {

// Fields of one CSV line. A field in double quotes may hold commas, and "" inside it is one quote.
std::vector<std::string> split_csv_line(std::string_view line);

struct Receipt {
  Sku sku;
  int quantity;
  BinLocation bin;
};

// "BLT-0042,12,C-04-17" from a goods-in file.
Receipt parse_receipt(std::string_view line);

}  // namespace stockroom
