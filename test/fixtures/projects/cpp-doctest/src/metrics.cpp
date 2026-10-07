#include "throttle/metrics.hpp"

#include <sstream>

namespace throttle {

void Metrics::count(const std::string& route, Decision decision) {
  ++counts_[route][decision];
}

std::uint64_t Metrics::total(const std::string& route) const {
  const auto it = counts_.find(route);
  if (it == counts_.end()) {
    return 0;
  }
  std::uint64_t sum = 0;
  for (const auto& [decision, n] : it->second) sum += n;
  return sum;
}

std::string Metrics::render() const {
  std::ostringstream out;
  out << "# TYPE throttle_decisions_total counter\n";
  for (const auto& [route, decisions] : counts_) {
    for (const auto& [decision, n] : decisions) {
      out << "throttle_decisions_total{route=\"" << route << "\",decision=\"" << decision_name(decision) << "\"} " << n << '\n';
    }
  }
  return out.str();
}

}  // namespace throttle
