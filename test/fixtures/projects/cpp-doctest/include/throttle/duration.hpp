#pragma once

#include <stdexcept>
#include <string>
#include <string_view>

#include "throttle/clock.hpp"

namespace throttle {

class DurationError : public std::invalid_argument {
 public:
  using std::invalid_argument::invalid_argument;
};

// "250ms", "30s", "1m30s", "2h": whole numbers, each followed by a unit, largest unit first.
Millis parse_duration(std::string_view text);

// The shortest way parse_duration would read back: 90000ms is "1m30s".
std::string format_duration(Millis duration);

}  // namespace throttle
