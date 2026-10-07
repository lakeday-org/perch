#include "ledger/parse.hpp"

#include <algorithm>

namespace ledger {

std::int64_t parse_amount(std::string_view text, int digits) {
  if (text.empty()) {
    throw ParseError("empty amount");
  }
  bool negative = false;
  std::size_t at = 0;
  if (text[0] == '-') {
    negative = true;
    at = 1;
  }
  std::int64_t whole = 0;
  std::int64_t fraction = 0;
  int decimals = -1;
  bool any = false;
  for (; at < text.size(); ++at) {
    const char c = text[at];
    if (c == '.') {
      if (decimals >= 0) {
        throw ParseError("two decimal points in " + std::string(text));
      }
      decimals = 0;
      continue;
    }
    if (c < '0' || c > '9') {
      throw ParseError("not a digit: " + std::string(1, c));
    }
    any = true;
    if (decimals < 0) {
      whole = whole * 10 + (c - '0');
    } else {
      if (++decimals > digits) {
        throw ParseError("too many decimals in " + std::string(text));
      }
      fraction = fraction * 10 + (c - '0');
    }
  }
  if (!any) {
    throw ParseError("no digits in " + std::string(text));
  }
  for (int i = std::max(decimals, 0); i < digits; ++i) fraction *= 10;
  std::int64_t scale = 1;
  for (int i = 0; i < digits; ++i) scale *= 10;
  const std::int64_t minor = whole * scale + fraction;
  return negative ? -minor : minor;
}

std::vector<std::string_view> split_fields(std::string_view text) {
  std::vector<std::string_view> fields;
  std::size_t at = 0;
  while (at < text.size()) {
    while (at < text.size() && (text[at] == ' ' || text[at] == '\t')) ++at;
    const std::size_t start = at;
    while (at < text.size() && text[at] != ' ' && text[at] != '\t') ++at;
    if (at > start) fields.push_back(text.substr(start, at - start));
  }
  return fields;
}

Posting parse_posting(std::string_view line) {
  const auto fields = split_fields(line);
  if (fields.size() != 5) {
    throw ParseError("a posting has five fields, not " + std::to_string(fields.size()));
  }
  Side side;
  if (fields[1] == "debit") {
    side = Side::Debit;
  } else if (fields[1] == "credit") {
    side = Side::Credit;
  } else {
    throw ParseError("no side named " + std::string(fields[1]));
  }
  const auto currency = parse_currency(fields[4]);
  if (!currency) {
    throw ParseError("no currency named " + std::string(fields[4]));
  }
  const Money amount(parse_amount(fields[3], minor_units(*currency)), *currency);
  return Posting{std::string(fields[0]), side, std::string(fields[2]), amount};
}

}  // namespace ledger
