use std::fmt;

use crate::currency::Currency;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerError {
    UnknownAccount(String),
    DuplicateAccount(String),
    Unbalanced { entry: String, residual: i64 },
    CurrencyMismatch { left: Currency, right: Currency },
    Overflow,
    Parse { line: usize, message: String },
}

impl fmt::Display for LedgerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LedgerError::UnknownAccount(name) => write!(f, "no account named {name}"),
            LedgerError::DuplicateAccount(name) => write!(f, "{name} is already open"),
            LedgerError::Unbalanced { entry, residual } => write!(f, "{entry} is off by {residual}"),
            LedgerError::CurrencyMismatch { left, right } => write!(f, "cannot combine {left} with {right}"),
            LedgerError::Overflow => f.write_str("amount overflowed"),
            LedgerError::Parse { line, message } => write!(f, "line {line}: {message}"),
        }
    }
}

impl std::error::Error for LedgerError {}
