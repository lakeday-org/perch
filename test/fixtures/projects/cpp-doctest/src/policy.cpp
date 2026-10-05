#include "throttle/policy.hpp"

namespace throttle {

Decision decide(Strategy strategy, bool within_limit, std::size_t queued, std::size_t max_queue) {
  if (within_limit) {
    return Decision::Allow;
  }
  switch (strategy) {
    case Strategy::Drop:
      return Decision::Reject;
    case Strategy::Queue:
      return queued < max_queue ? Decision::Delay : Decision::Reject;
    case Strategy::Shed:
      return Decision::AllowShed;
  }
  return Decision::Reject;
}

const char* decision_name(Decision decision) {
  switch (decision) {
    case Decision::Allow:
      return "allow";
    case Decision::Delay:
      return "delay";
    case Decision::Reject:
      return "reject";
    case Decision::AllowShed:
      return "allow-shed";
  }
  return "unknown";
}

}  // namespace throttle
