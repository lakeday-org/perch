#pragma once

#include <cstddef>
#include <iterator>
#include <optional>

namespace ledger {

// The mean and the largest of the values seen so far, without keeping them.
template <typename T>
class RunningAverage {
 public:
  void add(T value) {
    if (count_ == 0 || value > max_) {
      max_ = value;
    }
    sum_ += value;
    ++count_;
  }

  std::size_t count() const { return count_; }

  double mean() const {
    if (count_ == 0) {
      return 0.0;
    }
    return static_cast<double>(sum_) / static_cast<double>(count_);
  }

  std::optional<T> max() const {
    if (count_ == 0) {
      return std::nullopt;
    }
    return max_;
  }

 private:
  T sum_{};
  T max_{};
  std::size_t count_ = 0;
};

// The element of `range` whose `key` is largest, the first of equals, or nullptr for an empty range.
template <typename Range, typename Key>
auto largest_by(const Range& range, Key key) -> decltype(&*std::begin(range)) {
  decltype(&*std::begin(range)) best = nullptr;
  for (const auto& item : range) {
    if (best == nullptr || key(*best) < key(item)) {
      best = &item;
    }
  }
  return best;
}

}  // namespace ledger
