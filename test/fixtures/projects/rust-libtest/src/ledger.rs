use std::collections::BTreeMap;

use crate::account::Account;
use crate::currency::Currency;
use crate::entry::Entry;
use crate::error::LedgerError;
use crate::money::Money;
use crate::period::Period;

/// Accounts and the entries posted to them, with running balances kept per account and currency.
#[derive(Debug, Default)]
pub struct Ledger {
    accounts: BTreeMap<String, Account>,
    balances: BTreeMap<(String, Currency), i64>,
    entries: Vec<Entry>,
}

impl Ledger {
    pub fn new() -> Ledger {
        Ledger::default()
    }

    pub fn open(&mut self, name: &str) -> Result<(), LedgerError> {
        if self.accounts.contains_key(name) {
            return Err(LedgerError::DuplicateAccount(name.to_string()));
        }
        let account = Account::new(name)?;
        self.accounts.insert(name.to_string(), account);
        Ok(())
    }

    pub fn close(&mut self, name: &str) -> Result<(), LedgerError> {
        match self.accounts.get_mut(name) {
            Some(account) => {
                account.close();
                Ok(())
            }
            None => Err(LedgerError::UnknownAccount(name.to_string())),
        }
    }

    /// Validate an entry and add its postings to the balances. Nothing is applied unless all of it is.
    pub fn post(&mut self, entry: Entry) -> Result<(), LedgerError> {
        entry.validate()?;
        for posting in &entry.postings {
            match self.accounts.get(&posting.account) {
                Some(account) if account.is_open() => {}
                _ => return Err(LedgerError::UnknownAccount(posting.account.clone())),
            }
        }
        for posting in &entry.postings {
            let key = (posting.account.clone(), posting.amount.currency());
            let slot = self.balances.entry(key).or_insert(0);
            *slot = slot.checked_add(posting.amount.minor()).ok_or(LedgerError::Overflow)?;
        }
        self.entries.push(entry);
        Ok(())
    }

    /// Post every entry, stopping at the first that fails. Returns how many posted.
    pub fn post_all(&mut self, entries: Vec<Entry>) -> Result<usize, LedgerError> {
        let mut posted = 0;
        for entry in entries {
            self.post(entry)?;
            posted += 1;
        }
        Ok(posted)
    }

    /// An account's balance on its normal side.
    pub fn balance(&self, name: &str, currency: Currency) -> Result<Money, LedgerError> {
        let account = self.accounts.get(name).ok_or_else(|| LedgerError::UnknownAccount(name.to_string()))?;
        let raw = self.balances.get(&(name.to_string(), currency)).copied().unwrap_or(0);
        Ok(Money::new(account.signed(raw), currency))
    }

    /// Every account and its raw balance in a currency, sorted by name, skipping accounts with nothing in it.
    pub fn trial_balance(&self, currency: Currency) -> Vec<(String, i64)> {
        self.balances
            .iter()
            .filter(|((_, c), amount)| *c == currency && **amount != 0)
            .map(|((name, _), amount)| (name.clone(), *amount))
            .collect()
    }

    pub fn entries_in(&self, period: Period) -> Vec<&Entry> {
        self.entries.iter().filter(|entry| period.contains(&entry.date)).collect()
    }

    pub fn accounts(&self) -> impl Iterator<Item = &Account> {
        self.accounts.values()
    }
}
