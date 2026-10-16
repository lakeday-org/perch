#include <doctest/doctest.h>

#include <stdexcept>
#include <string>

#include "throttle/lru_cache.hpp"

using throttle::LruCache;
using Squares = LruCache<int, int>;

TEST_CASE("LruCache forgets the least recently used key") {
  LruCache<std::string, int> cache(2);
  cache.get_or_create("a", [] { return 1; });
  cache.get_or_create("b", [] { return 2; });
  cache.get_or_create("a", [] { return 0; });
  cache.get_or_create("c", [] { return 3; });
  CHECK(cache.contains("a"));
  CHECK_FALSE(cache.contains("b"));
  CHECK(cache.size() == 2);
}

TEST_CASE("LruCache returns the value it already has") {
  LruCache<int, int> cache(4);
  cache.get_or_create(7, [] { return 49; });
  CHECK(cache.get_or_create(7, [] { return -1; }) == 49);
}

TEST_CASE("LruCache refuses a capacity of zero") {
  CHECK_THROWS_AS(Squares(0), std::invalid_argument);
}

TEST_CASE("LruCache holds a million keys" * doctest::skip()) {
  LruCache<int, int> cache(1'000'000);
  for (int i = 0; i < 2'000'000; ++i) cache.get_or_create(i, [i] { return i; });
  CHECK(cache.size() == 1'000'000);
}
