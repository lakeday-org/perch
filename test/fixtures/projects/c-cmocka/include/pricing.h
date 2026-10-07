#ifndef PRICING_H
#define PRICING_H

#include <stddef.h>

/* Takes percent off total, in minor units. Nothing off for no percentage, everything off for a hundred or more. */
long apply_discount(long total, int percent);
/* The percentage off for buying this many of one item. */
int discount_for_quantity(int quantity);
/* The tax rate for a region, in basis points. */
int tax_rate(const char *region);
/* The tax on an amount at a rate in basis points, rounded half up. */
long tax_for(long amount, int basis_points);

#define CART_MAX_ITEMS 32

typedef struct {
  const char *sku;
  long unit_price;
  int quantity;
} cart_item;

typedef struct {
  cart_item items[CART_MAX_ITEMS];
  size_t count;
  const char *region;
} cart;

void cart_init(cart *c, const char *region);
/* 0, or -1 when the cart is full or the quantity is not positive. */
int cart_add(cart *c, const char *sku, long unit_price, int quantity);
/* Every line's price after its quantity discount. */
long cart_subtotal(const cart *c);
/* The subtotal plus the region's tax on it. */
long cart_total(const cart *c);

#endif
