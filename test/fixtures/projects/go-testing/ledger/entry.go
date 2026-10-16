package ledger

import (
	"errors"

	"example.com/ledger/money"
)

// Side is which side of the books a line moves.
type Side int

const (
	Debit Side = iota
	Credit
)

// Line is one movement of an entry.
type Line struct {
	Account string
	Side    Side
	Amount  money.Money
}

// Entry is a journal entry: a memo and the lines that must balance.
type Entry struct {
	Memo  string
	Lines []Line
}

// NewEntry starts an entry with no lines.
func NewEntry(memo string) *Entry {
	return &Entry{Memo: memo}
}

// Debit adds a debit line and returns the entry, for chaining.
func (e *Entry) Debit(account string, amount money.Money) *Entry {
	e.Lines = append(e.Lines, Line{Account: account, Side: Debit, Amount: amount})
	return e
}

// Credit adds a credit line and returns the entry, for chaining.
func (e *Entry) Credit(account string, amount money.Money) *Entry {
	e.Lines = append(e.Lines, Line{Account: account, Side: Credit, Amount: amount})
	return e
}

// Totals sums each side.
func (e *Entry) Totals() (debits, credits int64) {
	for _, line := range e.Lines {
		if line.Side == Debit {
			debits += line.Amount.Minor
		} else {
			credits += line.Amount.Minor
		}
	}
	return debits, credits
}

// IsBalanced reports whether debits equal credits.
func (e *Entry) IsBalanced() bool {
	debits, credits := e.Totals()
	return debits == credits
}

// Validate says what is wrong with an entry that cannot be posted.
func (e *Entry) Validate() error {
	if len(e.Lines) < 2 {
		return errors.New("an entry needs at least two lines")
	}
	for _, line := range e.Lines {
		if line.Amount.IsZero() {
			return errors.New("a line cannot be zero")
		}
	}
	if !e.IsBalanced() {
		return errors.New("debits do not equal credits")
	}
	return nil
}
