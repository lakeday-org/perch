#include "throttle/clock.hpp"

namespace throttle {

Millis SteadyClock::now() const {
  return std::chrono::duration_cast<Millis>(std::chrono::steady_clock::now().time_since_epoch());
}

}  // namespace throttle
