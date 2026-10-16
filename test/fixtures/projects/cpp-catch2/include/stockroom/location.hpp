#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace stockroom {

// Where a bin is: aisle A to Z, shelf 1 to 99, slot 1 to 99. Written "C-04-17".
struct BinLocation {
  char aisle;
  int shelf;
  int slot;

  bool operator==(const BinLocation& other) const {
    return aisle == other.aisle && shelf == other.shelf && slot == other.slot;
  }
};

std::optional<BinLocation> parse_location(std::string_view text);

std::string format_location(const BinLocation& location);

// Steps a picker walks between two bins: along the aisles, then along the shelf.
int walk_distance(const BinLocation& from, const BinLocation& to);

}  // namespace stockroom
