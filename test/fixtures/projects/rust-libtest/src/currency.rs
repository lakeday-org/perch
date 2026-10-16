use std::fmt;

/// The currencies a journal may name. Amounts are held in the currency's minor unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Currency {
    Usd,
    Eur,
    Gbp,
    Jpy,
}

impl Currency {
    /// The currency an ISO 4217 code names, in any case.
    pub fn from_code(code: &str) -> Option<Currency> {
        match code.to_ascii_uppercase().as_str() {
            "USD" => Some(Currency::Usd),
            "EUR" => Some(Currency::Eur),
            "GBP" => Some(Currency::Gbp),
            "JPY" => Some(Currency::Jpy),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Currency::Usd => "USD",
            Currency::Eur => "EUR",
            Currency::Gbp => "GBP",
            Currency::Jpy => "JPY",
        }
    }

    /// Digits after the decimal point: the yen has no minor unit.
    pub fn decimals(self) -> u32 {
        match self {
            Currency::Jpy => 0,
            _ => 2,
        }
    }

    pub fn symbol(self) -> &'static str {
        match self {
            Currency::Usd => "$",
            Currency::Eur => "€",
            Currency::Gbp => "£",
            Currency::Jpy => "¥",
        }
    }
}

impl fmt::Display for Currency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_codes_in_any_case() {
        assert_eq!(Currency::from_code("usd"), Some(Currency::Usd));
        assert_eq!(Currency::from_code("Eur"), Some(Currency::Eur));
    }

    #[test]
    fn rejects_an_unknown_code() {
        assert_eq!(Currency::from_code("XYZ"), None);
    }

    #[test]
    fn yen_has_no_minor_unit() {
        assert_eq!(Currency::Jpy.decimals(), 0);
        assert_eq!(Currency::Gbp.decimals(), 2);
    }
}
