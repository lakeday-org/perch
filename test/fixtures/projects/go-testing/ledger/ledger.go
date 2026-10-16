package ledger

import (
	"fmt"

	"example.com/ledger/money"
)

// Account is a named balance.
type Account struct {
	Name    string
	Balance int64
}

// Ledger holds accounts in one currency and posts entries to them.
type Ledger struct {
	currency money.Currency
	accounts map[string]*Account
	posted   int
}

// Open starts a ledger with no accounts.
func Open(currency money.Currency) *Ledger {
	return &Ledger{currency: currency, accounts: map[string]*Account{}}
}

// OpenAccount adds an account with a zero balance.
func (l *Ledger) OpenAccount(name string) error {
	if _, exists := l.accounts[name]; exists {
		return fmt.Errorf("account %q already open", name)
	}
	l.accounts[name] = &Account{Name: name}
	return nil
}

// Post applies an entry to the accounts it names, or none of them.
func (l *Ledger) Post(entry *Entry) error {
	if err := entry.Validate(); err != nil {
		return err
	}
	for _, line := range entry.Lines {
		if _, ok := l.accounts[line.Account]; !ok {
			return fmt.Errorf("unknown account %q", line.Account)
		}
		if line.Amount.Currency != l.currency {
			return fmt.Errorf("%s is not the ledger's currency", line.Amount.Currency)
		}
	}
	for _, line := range entry.Lines {
		account := l.accounts[line.Account]
		if line.Side == Debit {
			account.Balance += line.Amount.Minor
		} else {
			account.Balance -= line.Amount.Minor
		}
	}
	l.posted++
	return nil
}

// Balance is an account's balance as money.
func (l *Ledger) Balance(name string) (money.Money, error) {
	account, ok := l.accounts[name]
	if !ok {
		return money.Money{}, fmt.Errorf("unknown account %q", name)
	}
	return money.New(account.Balance, l.currency), nil
}

// Posted counts the entries posted so far.
func (l *Ledger) Posted() int {
	return l.posted
}

// TrialBalance sums every balance; zero when the books balance.
func (l *Ledger) TrialBalance() int64 {
	var total int64
	for _, account := range l.accounts {
		total += account.Balance
	}
	return total
}
