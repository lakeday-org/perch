#pragma once

#include <cstdint>
#include <map>
#include <string>

#include "throttle/policy.hpp"

namespace throttle {

// Decisions counted by route, for a /metrics endpoint.
class Metrics {
 public:
  void count(const std::string& route, Decision decision);
  std::uint64_t total(const std::string& route) const;

  // Prometheus text exposition: one throttle_decisions_total line per route and decision.
  std::string render() const;

 private:
  std::map<std::string, std::map<Decision, std::uint64_t>> counts_;
};

}  // namespace throttle
