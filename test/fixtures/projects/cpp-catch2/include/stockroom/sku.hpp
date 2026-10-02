#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace stockroom {

// A stock-keeping unit: three capital letters, a dash, four digits. "BLT-0042".
class Sku {
 public:
  explicit Sku(std::string code);

  const std::string& code() const { return code_; }
  std::string_view family() const;
  int number() const;

  bool operator<(const Sku& other) const { return code_ < other.code_; }
  bool operator==(const Sku& other) const { return code_ == other.code_; }

 private:
  std::string code_;
};

bool is_valid_sku(std::string_view text);

// Upper-cases and trims the text before checking it, as a scanner or a person typing would give it.
std::optional<Sku> parse_sku(std::string_view text);

}  // namespace stockroom
