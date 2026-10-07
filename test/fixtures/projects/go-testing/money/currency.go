package money

import "fmt"

// Currency is an ISO 4217 code.
type Currency string

const (
	USD Currency = "USD"
	EUR Currency = "EUR"
	JPY Currency = "JPY"
)

// MinorUnits is how many decimal places a currency's amounts carry.
func MinorUnits(c Currency) int {
	if c == JPY {
		return 0
	}
	return 2
}

// Parse reads a currency code, rejecting any this package does not know.
func Parse(code string) (Currency, error) {
	switch Currency(code) {
	case USD, EUR, JPY:
		return Currency(code), nil
	}
	return "", fmt.Errorf("unknown currency %q", code)
}
