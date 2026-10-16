#include <stdlib.h>

#include <check.h>

#include "suites.h"

int main(void)
{
  SRunner *sr = srunner_create(money_suite());
  srunner_add_suite(sr, ledger_suite());
  srunner_run_all(sr, CK_NORMAL);
  int failed = srunner_ntests_failed(sr);
  srunner_free(sr);
  return failed == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
