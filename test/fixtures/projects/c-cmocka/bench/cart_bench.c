/* Times cart_total over a full cart, where the discounts and the tax are both computed. */
#include <stdio.h>
#include <time.h>

#include "pricing.h"

int main(void) {
  cart c;
  cart_init(&c, "CA");
  for (int i = 0; i < CART_MAX_ITEMS; i++) cart_add(&c, "widget", 100 + i, 1 + i);
  clock_t start = clock();
  long total = 0;
  for (int round = 0; round < 100000; round++) total += cart_total(&c);
  double seconds = (double)(clock() - start) / CLOCKS_PER_SEC;
  printf("%ld in %.3fs\n", total, seconds);
  return 0;
}
