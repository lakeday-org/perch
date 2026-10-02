#pragma once

#include <cstddef>
#include <list>
#include <stdexcept>
#include <unordered_map>
#include <utility>

namespace throttle {

// A map that forgets the least recently used key once it holds `capacity` of them.
template <typename Key, typename Value>
class LruCache {
 public:
  explicit LruCache(std::size_t capacity) : capacity_(capacity) {
    if (capacity == 0) {
      throw std::invalid_argument("an LRU cache holds at least one entry");
    }
  }

  // The value for `key`, made with `make()` when there is none, marked as most recently used.
  template <typename Make>
  Value& get_or_create(const Key& key, Make make) {
    auto found = index_.find(key);
    if (found != index_.end()) {
      order_.splice(order_.begin(), order_, found->second);
      return found->second->second;
    }
    if (order_.size() == capacity_) {
      index_.erase(order_.back().first);
      order_.pop_back();
    }
    order_.emplace_front(key, make());
    index_.emplace(key, order_.begin());
    return order_.front().second;
  }

  bool contains(const Key& key) const { return index_.count(key) > 0; }
  std::size_t size() const { return order_.size(); }

 private:
  std::size_t capacity_;
  std::list<std::pair<Key, Value>> order_;
  std::unordered_map<Key, typename std::list<std::pair<Key, Value>>::iterator> index_;
};

}  // namespace throttle
