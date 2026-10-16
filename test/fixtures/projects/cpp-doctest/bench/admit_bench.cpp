// Admits ten million requests over a thousand keys and prints the rate.
#include <chrono>
#include <iostream>
#include <string>
#include <vector>

#include "throttle/limiter.hpp"

int main() {
  throttle::SteadyClock clock;
  throttle::Limiter limiter(throttle::LimiterConfig{}, clock);
  std::vector<std::string> keys;
  for (int i = 0; i < 1000; ++i) keys.push_back("client-" + std::to_string(i));
  const auto start = std::chrono::steady_clock::now();
  std::size_t allowed = 0;
  for (int i = 0; i < 10'000'000; ++i) allowed += limiter.admit(keys[i % keys.size()]) == throttle::Decision::Allow;
  const std::chrono::duration<double> elapsed = std::chrono::steady_clock::now() - start;
  std::cout << allowed << " allowed, " << 1e7 / elapsed.count() << " decisions a second\n";
  return 0;
}
