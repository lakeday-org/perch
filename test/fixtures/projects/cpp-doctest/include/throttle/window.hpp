#pragma once

#include <cstddef>
#include <deque>

#include "throttle/clock.hpp"

namespace throttle {

// At most `limit` events in any `span` of time.
class SlidingWindow {
 public:
  SlidingWindow(std::size_t limit, Millis span);

  // Records the event and says yes when it fits; a refused event is not recorded.
  bool admit(Millis at);
  std::size_t count(Millis at);

 private:
  void expire(Millis at);

  std::size_t limit_;
  Millis span_;
  std::deque<Millis> events_;
};

}  // namespace throttle
