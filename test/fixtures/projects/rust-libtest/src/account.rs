use crate::error::LedgerError;

/// The five kinds of account, which decide the side a balance normally sits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AccountKind {
    Asset,
    Liability,
    Equity,
    Income,
    Expense,
}

impl AccountKind {
    /// The kind a journal path's first segment names: `assets:checking` is an asset.
    pub fn from_path(path: &str) -> Result<AccountKind, LedgerError> {
        let root = path.split(':').next().unwrap_or_default();
        match root {
            "assets" => Ok(AccountKind::Asset),
            "liabilities" => Ok(AccountKind::Liability),
            "equity" => Ok(AccountKind::Equity),
            "income" | "revenue" => Ok(AccountKind::Income),
            "expenses" => Ok(AccountKind::Expense),
            _ => Err(LedgerError::UnknownAccount(path.to_string())),
        }
    }

    /// Whether a debit raises the balance. Assets and expenses are debit-normal; the rest are credit-normal.
    pub fn is_debit_normal(self) -> bool {
        matches!(self, AccountKind::Asset | AccountKind::Expense)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub name: String,
    pub kind: AccountKind,
    closed: bool,
}

impl Account {
    pub fn new(name: &str) -> Result<Account, LedgerError> {
        let kind = AccountKind::from_path(name)?;
        Ok(Account { name: name.to_string(), kind, closed: false })
    }

    pub fn close(&mut self) {
        self.closed = true;
    }

    pub fn is_open(&self) -> bool {
        !self.closed
    }

    /// The account's balance as a reader expects to see it: positive on its normal side.
    pub fn signed(&self, raw: i64) -> i64 {
        if self.kind.is_debit_normal() {
            raw
        } else {
            -raw
        }
    }

    /// The account one level up: `expenses:food` for `expenses:food:groceries`, none for a root.
    pub fn parent(&self) -> Option<&str> {
        self.name.rfind(':').map(|at| &self.name[..at])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_comes_from_the_first_segment() {
        assert_eq!(AccountKind::from_path("liabilities:visa").unwrap(), AccountKind::Liability);
        assert_eq!(AccountKind::from_path("revenue:consulting").unwrap(), AccountKind::Income);
    }

    #[test]
    fn an_unknown_root_is_an_error() {
        assert!(Account::new("savings:jar").is_err());
    }

    #[test]
    fn credit_normal_accounts_flip_their_sign() {
        let card = Account::new("liabilities:visa").unwrap();
        assert_eq!(card.signed(-300), 300);
    }
}
