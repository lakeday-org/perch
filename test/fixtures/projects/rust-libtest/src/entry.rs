use crate::error::LedgerError;
use crate::money::Money;
use crate::period::Period;

/// One line of an entry: an amount moved into or out of an account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Posting {
    pub account: String,
    pub amount: Money,
}

impl Posting {
    pub fn new(account: &str, amount: Money) -> Posting {
        Posting { account: account.to_string(), amount }
    }
}

/// A dated transaction whose postings sum to zero in every currency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub date: String,
    pub memo: String,
    pub postings: Vec<Posting>,
}

impl Entry {
    pub fn new(date: &str, memo: &str) -> Entry {
        Entry { date: date.to_string(), memo: memo.to_string(), postings: Vec::new() }
    }

    pub fn with(mut self, account: &str, amount: Money) -> Entry {
        self.postings.push(Posting::new(account, amount));
        self
    }

    pub fn period(&self) -> Option<Period> {
        Period::from_date(&self.date)
    }

    /// What the postings leave over in the first posting's currency. Zero when the entry balances.
    pub fn residual(&self) -> Result<i64, LedgerError> {
        let Some(first) = self.postings.first() else {
            return Ok(0);
        };
        let mut sum = Money::zero(first.amount.currency());
        for posting in &self.postings {
            sum = sum.checked_add(posting.amount)?;
        }
        Ok(sum.minor())
    }

    /// An entry posts when it has two postings or more and they balance.
    pub fn validate(&self) -> Result<(), LedgerError> {
        if self.postings.len() < 2 {
            return Err(LedgerError::Unbalanced { entry: self.memo.clone(), residual: self.residual()? });
        }
        match self.residual()? {
            0 => Ok(()),
            residual => Err(LedgerError::Unbalanced { entry: self.memo.clone(), residual }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::currency::Currency;

    fn usd(minor: i64) -> Money {
        Money::new(minor, Currency::Usd)
    }

    #[test]
    fn a_balanced_entry_validates() {
        let entry = Entry::new("2024-01-02", "coffee").with("expenses:food", usd(450)).with("assets:cash", usd(-450));
        assert_eq!(entry.validate(), Ok(()));
    }

    #[test]
    fn reports_the_residual_of_an_unbalanced_entry() {
        let entry = Entry::new("2024-01-02", "typo").with("expenses:food", usd(450)).with("assets:cash", usd(-405));
        assert_eq!(entry.validate(), Err(LedgerError::Unbalanced { entry: "typo".into(), residual: 45 }));
    }

    #[test]
    fn a_single_posting_never_balances() {
        let entry = Entry::new("2024-01-02", "lonely").with("assets:cash", usd(0));
        assert!(entry.validate().is_err());
    }
}
