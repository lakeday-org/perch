// throttle-replay: replays an access log through a limiter and prints what it would have decided.
//
//   throttle-replay --burst 20 --rate 5 < access.log
//
// Each line is "<milliseconds> <client key> <route>".
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>

#include "throttle/limiter.hpp"
#include "throttle/metrics.hpp"

int main(int argc, char** argv) {
  throttle::LimiterConfig config;
  for (int i = 1; i + 1 < argc; i += 2) {
    if (std::strcmp(argv[i], "--burst") == 0) config.burst = std::stod(argv[i + 1]);
    else if (std::strcmp(argv[i], "--rate") == 0) config.per_second = std::stod(argv[i + 1]);
  }
  throttle::ManualClock clock;
  throttle::Limiter limiter(config, clock);
  throttle::Metrics metrics;
  for (std::string line; std::getline(std::cin, line);) {
    std::istringstream fields(line);
    long long at = 0;
    std::string key, route;
    if (!(fields >> at >> key >> route)) continue;
    clock.advance(throttle::Millis{at} - clock.now());
    metrics.count(route, limiter.admit(key));
  }
  std::cout << metrics.render();
  return 0;
}
