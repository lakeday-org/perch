package ledger_test

import (
	"testing"

	"example.com/ledger/ledger"
	"example.com/ledger/money"
)

func usd(minor int64) money.Money {
	return money.New(minor, money.USD)
}

func openBook(t *testing.T) *ledger.Ledger {
	t.Helper()
	book := ledger.Open(money.USD)
	for _, name := range []string{"cash", "sales"} {
		if err := book.OpenAccount(name); err != nil {
			t.Fatal(err)
		}
	}
	return book
}

func TestPostMovesBothBalances(t *testing.T) {
	book := openBook(t)
	sale := ledger.NewEntry("invoice 1041").Debit("cash", usd(4999)).Credit("sales", usd(4999))
	if err := book.Post(sale); err != nil {
		t.Fatal(err)
	}
	cash, _ := book.Balance("cash")
	if cash.Minor != 4999 {
		t.Errorf("cash: got %d", cash.Minor)
	}
	if book.Posted() != 1 {
		t.Errorf("posted: got %d", book.Posted())
	}
}

func TestPostRejectsAnUnbalancedEntry(t *testing.T) {
	book := openBook(t)
	partial := ledger.NewEntry("partial").Debit("cash", usd(100)).Credit("sales", usd(90))
	if err := book.Post(partial); err == nil {
		t.Fatal("expected an error")
	}
	if book.Posted() != 0 {
		t.Errorf("posted: got %d", book.Posted())
	}
}

func TestPostToAnUnknownAccountLeavesEveryBalanceAlone(t *testing.T) {
	book := openBook(t)
	typo := ledger.NewEntry("typo").Debit("cash", usd(100)).Credit("slaes", usd(100))
	if err := book.Post(typo); err == nil {
		t.Fatal("expected an error")
	}
	cash, _ := book.Balance("cash")
	if !cash.IsZero() {
		t.Errorf("cash moved to %v", cash)
	}
}

func TestOpenAccountTwice(t *testing.T) {
	book := openBook(t)
	if err := book.OpenAccount("cash"); err == nil {
		t.Fatal("expected an error")
	}
}

func TestTrialBalanceIsZeroAfterPosting(t *testing.T) {
	book := openBook(t)
	sale := ledger.NewEntry("sale").Debit("cash", usd(800)).Credit("sales", usd(800))
	if err := book.Post(sale); err != nil {
		t.Fatal(err)
	}
	if book.TrialBalance() != 0 {
		t.Errorf("trial balance: got %d", book.TrialBalance())
	}
}

func TestEntryValidation(t *testing.T) {
	t.Run("needs two lines", func(t *testing.T) {
		if err := ledger.NewEntry("one").Debit("cash", usd(1)).Validate(); err == nil {
			t.Fatal("expected an error")
		}
	})
	t.Run("balanced", func(t *testing.T) {
		entry := ledger.NewEntry("two").Debit("cash", usd(5)).Credit("sales", usd(5))
		if !entry.IsBalanced() {
			t.Fatal("expected a balanced entry")
		}
	})
	t.Run("rejects a zero line", func(t *testing.T) {
		entry := ledger.NewEntry("zero").Debit("cash", usd(0)).Credit("sales", usd(0))
		if err := entry.Validate(); err == nil {
			t.Fatal("expected an error")
		}
	})
}
