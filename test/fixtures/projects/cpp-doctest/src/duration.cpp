#include "throttle/duration.hpp"

#include <cstdint>

namespace throttle {

namespace {

// Milliseconds in one of a unit, or zero for a unit that is not one.
std::int64_t unit_millis(std::string_view unit) {
  if (unit == "ms") return 1;
  if (unit == "s") return 1000;
  if (unit == "m") return 60 * 1000;
  if (unit == "h") return 60 * 60 * 1000;
  return 0;
}

}  // namespace

Millis parse_duration(std::string_view text) {
  if (text.empty()) {
    throw DurationError("empty duration");
  }
  std::int64_t total = 0;
  std::int64_t last_unit = INT64_MAX;
  std::size_t at = 0;
  while (at < text.size()) {
    const std::size_t digits = at;
    std::int64_t value = 0;
    while (at < text.size() && text[at] >= '0' && text[at] <= '9') {
      value = value * 10 + (text[at] - '0');
      ++at;
    }
    if (at == digits) {
      throw DurationError("expected a number in " + std::string(text));
    }
    const std::size_t unit_start = at;
    while (at < text.size() && (text[at] < '0' || text[at] > '9')) ++at;
    const std::int64_t unit = unit_millis(text.substr(unit_start, at - unit_start));
    if (unit == 0) {
      throw DurationError("no unit named \"" + std::string(text.substr(unit_start, at - unit_start)) + "\"");
    }
    if (unit >= last_unit) {
      throw DurationError("units out of order in " + std::string(text));
    }
    last_unit = unit;
    total += value * unit;
  }
  return Millis{total};
}

std::string format_duration(Millis duration) {
  std::int64_t left = duration.count();
  if (left == 0) {
    return "0ms";
  }
  std::string text;
  for (const auto& [unit, millis] : {std::pair<const char*, std::int64_t>{"h", 3600000}, {"m", 60000}, {"s", 1000}, {"ms", 1}}) {
    if (left >= millis) {
      text += std::to_string(left / millis) + unit;
      left %= millis;
    }
  }
  return text;
}

}  // namespace throttle
