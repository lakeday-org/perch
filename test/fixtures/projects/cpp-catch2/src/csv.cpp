#include "stockroom/csv.hpp"

#include <stdexcept>

namespace stockroom {

std::vector<std::string> split_csv_line(std::string_view line) {
  std::vector<std::string> fields(1);
  bool quoted = false;
  for (std::size_t i = 0; i < line.size(); ++i) {
    const char c = line[i];
    if (quoted) {
      if (c == '"' && i + 1 < line.size() && line[i + 1] == '"') {
        fields.back() += '"';
        ++i;
      } else if (c == '"') {
        quoted = false;
      } else {
        fields.back() += c;
      }
    } else if (c == '"') {
      quoted = true;
    } else if (c == ',') {
      fields.emplace_back();
    } else {
      fields.back() += c;
    }
  }
  if (quoted) {
    throw std::invalid_argument("unterminated quote");
  }
  return fields;
}

Receipt parse_receipt(std::string_view line) {
  const auto fields = split_csv_line(line);
  if (fields.size() != 3) {
    throw std::invalid_argument("a receipt has three fields");
  }
  const auto sku = parse_sku(fields[0]);
  if (!sku) {
    throw std::invalid_argument("not a SKU: " + fields[0]);
  }
  const int quantity = std::stoi(fields[1]);
  const auto bin = parse_location(fields[2]);
  if (!bin) {
    throw std::invalid_argument("not a bin: " + fields[2]);
  }
  return Receipt{*sku, quantity, *bin};
}

}  // namespace stockroom
