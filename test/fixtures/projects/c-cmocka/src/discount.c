#include "pricing.h"

long apply_discount(long total, int percent) {
  if (percent <= 0) return total;
  if (percent >= 100) return 0;
  return total - total * percent / 100;
}

int discount_for_quantity(int quantity) {
  if (quantity >= 100) return 15;
  if (quantity >= 10) return 5;
  return 0;
}
