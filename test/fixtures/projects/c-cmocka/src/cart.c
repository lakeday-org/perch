#include <string.h>

#include "pricing.h"

void cart_init(cart *c, const char *region) {
  memset(c, 0, sizeof *c);
  c->region = region;
}

int cart_add(cart *c, const char *sku, long unit_price, int quantity) {
  if (c->count >= CART_MAX_ITEMS || quantity <= 0) return -1;
  c->items[c->count].sku = sku;
  c->items[c->count].unit_price = unit_price;
  c->items[c->count].quantity = quantity;
  c->count++;
  return 0;
}

long cart_subtotal(const cart *c) {
  long subtotal = 0;
  for (size_t i = 0; i < c->count; i++) {
    long line = c->items[i].unit_price * c->items[i].quantity;
    subtotal += apply_discount(line, discount_for_quantity(c->items[i].quantity));
  }
  return subtotal;
}

long cart_total(const cart *c) {
  long subtotal = cart_subtotal(c);
  return subtotal + tax_for(subtotal, tax_rate(c->region));
}
