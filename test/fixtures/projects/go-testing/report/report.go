package report

import (
	"sort"

	"example.com/ledger/ledger"
	"example.com/ledger/money"
)

// AgingBucket names the bucket an invoice this many days overdue falls in.
func AgingBucket(daysOverdue int) string {
	switch {
	case daysOverdue <= 0:
		return "current"
	case daysOverdue <= 30:
		return "1-30"
	case daysOverdue <= 60:
		return "31-60"
	}
	return "61+"
}

// Balances lists the named accounts' balances, in name order.
func Balances(book *ledger.Ledger, names []string) ([]money.Money, error) {
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	out := make([]money.Money, 0, len(sorted))
	for _, name := range sorted {
		balance, err := book.Balance(name)
		if err != nil {
			return nil, err
		}
		out = append(out, balance)
	}
	return out, nil
}
