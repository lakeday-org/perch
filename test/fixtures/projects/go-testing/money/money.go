package money

import "fmt"

// Money is an amount in a currency's minor units.
type Money struct {
	Minor    int64
	Currency Currency
}

// New makes an amount.
func New(minor int64, currency Currency) Money {
	return Money{Minor: minor, Currency: currency}
}

// Add sums two amounts of one currency.
func (m Money) Add(other Money) (Money, error) {
	if m.Currency != other.Currency {
		return Money{}, fmt.Errorf("cannot add %s to %s", other.Currency, m.Currency)
	}
	return Money{Minor: m.Minor + other.Minor, Currency: m.Currency}, nil
}

// IsZero reports whether the amount is nothing.
func (m Money) IsZero() bool {
	return m.Minor == 0
}

// Allocate splits the amount into parts, handing the remainder to the first parts one minor unit at a time.
func (m Money) Allocate(parts int) ([]Money, error) {
	if parts <= 0 {
		return nil, fmt.Errorf("cannot allocate into %d parts", parts)
	}
	share := m.Minor / int64(parts)
	remainder := m.Minor - share*int64(parts)
	out := make([]Money, parts)
	for i := range out {
		minor := share
		if int64(i) < remainder {
			minor++
		}
		out[i] = Money{Minor: minor, Currency: m.Currency}
	}
	return out, nil
}

// String formats the amount with the currency's decimal places.
func (m Money) String() string {
	if MinorUnits(m.Currency) == 0 {
		return fmt.Sprintf("%d %s", m.Minor, m.Currency)
	}
	return fmt.Sprintf("%d.%02d %s", m.Minor/100, m.Minor%100, m.Currency)
}
