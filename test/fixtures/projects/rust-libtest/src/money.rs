use std::fmt;
use std::ops::Neg;

use crate::currency::Currency;
use crate::error::LedgerError;

/// An amount in a currency's minor unit: cents, pence, or whole yen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Money {
    minor: i64,
    currency: Currency,
}

impl Money {
    pub fn new(minor: i64, currency: Currency) -> Money {
        Money { minor, currency }
    }

    pub fn zero(currency: Currency) -> Money {
        Money::new(0, currency)
    }

    pub fn minor(&self) -> i64 {
        self.minor
    }

    pub fn currency(&self) -> Currency {
        self.currency
    }

    pub fn is_zero(&self) -> bool {
        self.minor == 0
    }

    /// The sum of two amounts in the same currency. Adding dollars to euros is an error, not a conversion.
    pub fn checked_add(self, other: Money) -> Result<Money, LedgerError> {
        if self.currency != other.currency {
            return Err(LedgerError::CurrencyMismatch { left: self.currency, right: other.currency });
        }
        self.minor
            .checked_add(other.minor)
            .map(|minor| Money::new(minor, self.currency))
            .ok_or(LedgerError::Overflow)
    }

    /// Split into `parts` amounts that add back up to this one, the remainder going to the first parts.
    pub fn allocate(self, parts: usize) -> Vec<Money> {
        if parts == 0 {
            return Vec::new();
        }
        let base = self.minor / parts as i64;
        let mut remainder = self.minor % parts as i64;
        let mut out = Vec::with_capacity(parts);
        for _ in 0..parts {
            let extra = if remainder > 0 {
                remainder -= 1;
                1
            } else if remainder < 0 {
                remainder += 1;
                -1
            } else {
                0
            };
            out.push(Money::new(base + extra, self.currency));
        }
        out
    }
}

impl Neg for Money {
    type Output = Money;

    fn neg(self) -> Money {
        Money::new(-self.minor, self.currency)
    }
}

impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let decimals = self.currency.decimals();
        if decimals == 0 {
            return write!(f, "{} {}", self.minor, self.currency);
        }
        let scale = 10_i64.pow(decimals);
        let sign = if self.minor < 0 { "-" } else { "" };
        let abs = self.minor.abs();
        write!(f, "{}{}.{:0width$} {}", sign, abs / scale, abs % scale, self.currency, width = decimals as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_amounts_in_one_currency() {
        let sum = Money::new(150, Currency::Usd).checked_add(Money::new(275, Currency::Usd)).unwrap();
        assert_eq!(sum, Money::new(425, Currency::Usd));
    }

    #[test]
    fn refuses_to_add_across_currencies() {
        let err = Money::new(1, Currency::Usd).checked_add(Money::new(1, Currency::Eur)).unwrap_err();
        assert_eq!(err, LedgerError::CurrencyMismatch { left: Currency::Usd, right: Currency::Eur });
    }

    #[test]
    fn allocation_gives_the_remainder_to_the_first_parts() {
        let parts = Money::new(100, Currency::Usd).allocate(3);
        assert_eq!(parts.iter().map(Money::minor).collect::<Vec<_>>(), vec![34, 33, 33]);
    }

    #[test]
    fn displays_negative_cents() {
        assert_eq!(Money::new(-1205, Currency::Usd).to_string(), "-12.05 USD");
        assert_eq!(Money::new(500, Currency::Jpy).to_string(), "500 JPY");
    }
}
