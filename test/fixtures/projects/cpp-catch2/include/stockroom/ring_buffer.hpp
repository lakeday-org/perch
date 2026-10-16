#pragma once

#include <array>
#include <cstddef>
#include <stdexcept>

namespace stockroom {

// The last N values pushed, oldest first: daily sales for a moving average of demand.
template <typename T, std::size_t N>
class RingBuffer {
  static_assert(N > 0, "a ring buffer holds at least one value");

 public:
  void push(const T& value) {
    values_[(start_ + size_) % N] = value;
    if (size_ < N) {
      ++size_;
    } else {
      start_ = (start_ + 1) % N;
    }
  }

  std::size_t size() const { return size_; }
  bool full() const { return size_ == N; }

  const T& at(std::size_t index) const {
    if (index >= size_) {
      throw std::out_of_range("ring buffer index");
    }
    return values_[(start_ + index) % N];
  }

  double mean() const {
    if (size_ == 0) {
      return 0.0;
    }
    double sum = 0;
    for (std::size_t i = 0; i < size_; ++i) sum += at(i);
    return sum / static_cast<double>(size_);
  }

 private:
  std::array<T, N> values_{};
  std::size_t start_ = 0;
  std::size_t size_ = 0;
};

}  // namespace stockroom
