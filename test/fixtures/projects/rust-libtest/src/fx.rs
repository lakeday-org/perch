//! Conversion between currencies at quoted rates. Nothing in the ledger converts yet; reports will.

use std::collections::HashMap;

use crate::currency::Currency;
use crate::money::Money;
use crate::rounding::{scale, RoundingMode};

/// Rates quoted as how many millionths of `to` one minor unit of `from` buys.
#[derive(Debug, Default)]
pub struct FxTable {
    rates: HashMap<(Currency, Currency), i64>,
}

impl FxTable {
    pub fn new() -> FxTable {
        FxTable::default()
    }

    pub fn quote(&mut self, from: Currency, to: Currency, micros: i64) {
        self.rates.insert((from, to), micros);
    }

    /// The rate from one currency to another: quoted, the inverse of a quote, or one for the same currency.
    pub fn rate(&self, from: Currency, to: Currency) -> Option<i64> {
        if from == to {
            return Some(1_000_000);
        }
        if let Some(rate) = self.rates.get(&(from, to)) {
            return Some(*rate);
        }
        self.rates.get(&(to, from)).filter(|rate| **rate != 0).map(|rate| 1_000_000_000_000 / rate)
    }

    pub fn convert(&self, amount: Money, to: Currency) -> Option<Money> {
        let rate = self.rate(amount.currency(), to)?;
        let shift = to.decimals() as i32 - amount.currency().decimals() as i32;
        let (numerator, denominator) = if shift >= 0 {
            (rate * 10_i64.pow(shift as u32), 1_000_000)
        } else {
            (rate, 1_000_000 * 10_i64.pow((-shift) as u32))
        };
        Some(Money::new(scale(amount.minor(), numerator, denominator, RoundingMode::HalfEven), to))
    }
}
