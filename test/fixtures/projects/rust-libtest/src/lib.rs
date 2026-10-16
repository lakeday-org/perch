//! Double-entry bookkeeping over a plain-text journal.
//!
//! ```text
//! 2024-03-01 Rent
//!     expenses:rent      1200.00 USD
//!     assets:checking   -1200.00 USD
//! ```

pub mod account;
pub mod currency;
pub mod entry;
pub mod error;
pub mod fx;
pub mod ledger;
pub mod money;
pub mod parse;
pub mod period;
pub mod report;
pub mod rounding;

pub use crate::account::{Account, AccountKind};
pub use crate::currency::Currency;
pub use crate::entry::{Entry, Posting};
pub use crate::error::LedgerError;
pub use crate::ledger::Ledger;
pub use crate::money::Money;
pub use crate::parse::{parse, parse_amount};
pub use crate::period::Period;
pub use crate::report::{CsvReport, Report, TrialBalanceReport};
