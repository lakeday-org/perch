#include "throttle/window.hpp"

#include <stdexcept>

namespace throttle {

SlidingWindow::SlidingWindow(std::size_t limit, Millis span) : limit_(limit), span_(span) {
  if (limit == 0 || span.count() <= 0) {
    throw std::invalid_argument("a window needs a limit and a span");
  }
}

void SlidingWindow::expire(Millis at) {
  while (!events_.empty() && at - events_.front() >= span_) {
    events_.pop_front();
  }
}

bool SlidingWindow::admit(Millis at) {
  expire(at);
  if (events_.size() >= limit_) {
    return false;
  }
  events_.push_back(at);
  return true;
}

std::size_t SlidingWindow::count(Millis at) {
  expire(at);
  return events_.size();
}

}  // namespace throttle
