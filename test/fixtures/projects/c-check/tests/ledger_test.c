#include <check.h>

#include "ledger.h"
#include "suites.h"

static ledger book;

static money usd(int64_t minor) {
  return money_new(minor, USD);
}

static void open_accounts(void)
{
  ledger_open(&book, USD);
  ledger_open_account(&book, "cash");
  ledger_open_account(&book, "sales");
}

START_TEST(posts_a_balanced_entry)
{
  entry sale;
  entry_init(&sale, "invoice 1041");
  entry_debit(&sale, "cash", usd(4999));
  entry_credit(&sale, "sales", usd(4999));
  ck_assert_int_eq(ledger_post(&book, &sale), 0);
  money cash;
  ck_assert_int_eq(ledger_balance(&book, "cash", &cash), 0);
  ck_assert_int_eq(cash.minor, 4999);
  ck_assert_int_eq(book.posted, 1);
}
END_TEST

START_TEST(rejects_an_unbalanced_entry)
{
  entry partial;
  entry_init(&partial, "partial");
  entry_debit(&partial, "cash", usd(100));
  entry_credit(&partial, "sales", usd(90));
  ck_assert_int_ne(ledger_post(&book, &partial), 0);
  ck_assert_int_eq(book.posted, 0);
}
END_TEST

START_TEST(leaves_every_balance_alone_when_an_account_is_unknown)
{
  entry typo;
  entry_init(&typo, "typo");
  entry_debit(&typo, "cash", usd(100));
  entry_credit(&typo, "slaes", usd(100));
  ck_assert_int_ne(ledger_post(&book, &typo), 0);
  money cash;
  ledger_balance(&book, "cash", &cash);
  ck_assert_int_eq(cash.minor, 0);
}
END_TEST

START_TEST(refuses_to_open_an_account_twice)
{
  ck_assert_int_ne(ledger_open_account(&book, "cash"), 0);
}
END_TEST

START_TEST(trial_balance_is_zero_after_posting)
{
  entry sale;
  entry_init(&sale, "sale");
  entry_debit(&sale, "cash", usd(800));
  entry_credit(&sale, "sales", usd(800));
  ledger_post(&book, &sale);
  ck_assert_int_eq(ledger_trial_balance(&book), 0);
}
END_TEST

START_TEST(an_entry_needs_two_lines)
{
  entry one;
  entry_init(&one, "one");
  entry_debit(&one, "cash", usd(1));
  ck_assert_int_ne(entry_validate(&one), 0);
}
END_TEST

START_TEST(a_balanced_entry_validates)
{
  entry two;
  entry_init(&two, "two");
  entry_debit(&two, "cash", usd(5));
  entry_credit(&two, "sales", usd(5));
  ck_assert(entry_is_balanced(&two));
  ck_assert_int_eq(entry_validate(&two), 0);
}
END_TEST

Suite *ledger_suite(void)
{
  Suite *s = suite_create("Ledger");

  TCase *tc_post = tcase_create("Posting");
  tcase_add_checked_fixture(tc_post, open_accounts, NULL);
  tcase_add_test(tc_post, posts_a_balanced_entry);
  tcase_add_test(tc_post, rejects_an_unbalanced_entry);
  tcase_add_test(tc_post, leaves_every_balance_alone_when_an_account_is_unknown);
  tcase_add_test(tc_post, refuses_to_open_an_account_twice);
  tcase_add_test(tc_post, trial_balance_is_zero_after_posting);
  suite_add_tcase(s, tc_post);

  TCase *tc_entry = tcase_create("Entries");
  tcase_add_test(tc_entry, an_entry_needs_two_lines);
  tcase_add_test(tc_entry, a_balanced_entry_validates);
  suite_add_tcase(s, tc_entry);

  return s;
}
