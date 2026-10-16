package report_test

import (
	"testing"

	"example.com/ledger/ledger"
	"example.com/ledger/money"
	"example.com/ledger/report"
)

func TestAgingBucket(t *testing.T) {
	cases := map[string]struct {
		days int
		want string
	}{
		"not yet due": {0, "current"},
		"a month":     {30, "1-30"},
		"two months":  {45, "31-60"},
		"older":       {90, "61+"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := report.AgingBucket(tc.days); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBalancesReadsEveryAccount(t *testing.T) {
	book := ledger.Open(money.USD)
	for _, name := range []string{"cash", "sales"} {
		if err := book.OpenAccount(name); err != nil {
			t.Fatal(err)
		}
	}
	balances, err := report.Balances(book, []string{"sales", "cash"})
	if err != nil || len(balances) != 2 {
		t.Fatalf("got %v, %v", balances, err)
	}
}

func TestBalancesRejectsAnUnknownAccount(t *testing.T) {
	if _, err := report.Balances(ledger.Open(money.USD), []string{"petty cash"}); err == nil {
		t.Fatal("expected an error")
	}
}
