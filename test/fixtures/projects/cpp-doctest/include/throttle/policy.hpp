#pragma once

#include <cstddef>

namespace throttle {

// What to do with a request over the limit.
enum class Strategy {
  Drop,   // refuse it
  Queue,  // hold it until a token comes, while the queue has room
  Shed    // let it through but mark it as shed, for a downstream that degrades
};

enum class Decision { Allow, Delay, Reject, AllowShed };

Decision decide(Strategy strategy, bool within_limit, std::size_t queued, std::size_t max_queue);

const char* decision_name(Decision decision);

}  // namespace throttle
