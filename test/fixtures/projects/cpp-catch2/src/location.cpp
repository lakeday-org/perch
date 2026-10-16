#include "stockroom/location.hpp"

#include <cstdio>
#include <cstdlib>

namespace stockroom {

namespace {

std::optional<int> two_digits(std::string_view text) {
  if (text.size() != 2 || text[0] < '0' || text[0] > '9' || text[1] < '0' || text[1] > '9') {
    return std::nullopt;
  }
  const int value = (text[0] - '0') * 10 + (text[1] - '0');
  if (value == 0) {
    return std::nullopt;
  }
  return value;
}

}  // namespace

std::optional<BinLocation> parse_location(std::string_view text) {
  if (text.size() != 7 || text[1] != '-' || text[4] != '-') {
    return std::nullopt;
  }
  if (text[0] < 'A' || text[0] > 'Z') {
    return std::nullopt;
  }
  const auto shelf = two_digits(text.substr(2, 2));
  const auto slot = two_digits(text.substr(5, 2));
  if (!shelf || !slot) {
    return std::nullopt;
  }
  return BinLocation{text[0], *shelf, *slot};
}

std::string format_location(const BinLocation& location) {
  char buffer[8];
  std::snprintf(buffer, sizeof buffer, "%c-%02d-%02d", location.aisle, location.shelf, location.slot);
  return buffer;
}

int walk_distance(const BinLocation& from, const BinLocation& to) {
  const int aisles = std::abs(from.aisle - to.aisle);
  if (aisles == 0) {
    return std::abs(from.slot - to.slot);
  }
  // Changing aisle means walking out to the cross aisle at slot 0 and back in.
  return aisles * 10 + from.slot + to.slot;
}

}  // namespace stockroom
