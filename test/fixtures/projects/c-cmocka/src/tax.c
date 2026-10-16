#include <string.h>

#include "pricing.h"

int tax_rate(const char *region) {
  if (region == NULL) return 0;
  if (strcmp(region, "CA") == 0) return 725;
  if (strcmp(region, "NY") == 0) return 400;
  if (strcmp(region, "OR") == 0) return 0;
  return 500;
}

long tax_for(long amount, int basis_points) {
  if (amount <= 0 || basis_points <= 0) return 0;
  return (amount * basis_points + 5000) / 10000;
}
