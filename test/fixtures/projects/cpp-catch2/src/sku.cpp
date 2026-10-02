#include "stockroom/sku.hpp"

#include <cctype>
#include <stdexcept>
#include <utility>

namespace stockroom {

Sku::Sku(std::string code) : code_(std::move(code)) {
  if (!is_valid_sku(code_)) {
    throw std::invalid_argument("not a SKU: " + code_);
  }
}

std::string_view Sku::family() const {
  return std::string_view(code_).substr(0, 3);
}

int Sku::number() const {
  return std::stoi(code_.substr(4));
}

bool is_valid_sku(std::string_view text) {
  if (text.size() != 8 || text[3] != '-') {
    return false;
  }
  for (std::size_t i = 0; i < 3; ++i) {
    if (!std::isupper(static_cast<unsigned char>(text[i]))) return false;
  }
  for (std::size_t i = 4; i < 8; ++i) {
    if (!std::isdigit(static_cast<unsigned char>(text[i]))) return false;
  }
  return true;
}

std::optional<Sku> parse_sku(std::string_view text) {
  while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front()))) text.remove_prefix(1);
  while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.remove_suffix(1);
  std::string code(text);
  for (char& c : code) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  if (!is_valid_sku(code)) {
    return std::nullopt;
  }
  return Sku(code);
}

}  // namespace stockroom
