#pragma once

#include <cstddef>
#include <string>

#include "ledger/ledger.hpp"

namespace ledger {

// The accounts and their balances as a fixed-width table, with the trial balance on the last line.
std::string render_trial_balance(const Ledger& ledger);

std::string pad_right(std::string text, std::size_t width);

}  // namespace ledger
