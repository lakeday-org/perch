use crate::currency::Currency;
use crate::ledger::Ledger;
use crate::money::Money;

/// A way of laying a ledger out as text.
pub trait Report {
    fn render(&self, ledger: &Ledger) -> String;

    fn title(&self) -> &str {
        "report"
    }
}

/// Accounts and balances, debits and credits in their own columns, totalled at the foot.
pub struct TrialBalanceReport {
    pub currency: Currency,
}

impl TrialBalanceReport {
    pub fn new(currency: Currency) -> TrialBalanceReport {
        TrialBalanceReport { currency }
    }
}

impl Report for TrialBalanceReport {
    fn render(&self, ledger: &Ledger) -> String {
        let mut out = String::new();
        let (mut debits, mut credits) = (0_i64, 0_i64);
        for (name, raw) in ledger.trial_balance(self.currency) {
            let amount = Money::new(raw.abs(), self.currency);
            if raw >= 0 {
                debits += raw;
                out.push_str(&format!("{name:<30} {amount:>16}\n"));
            } else {
                credits -= raw;
                out.push_str(&format!("{name:<30} {:>16} {amount:>16}\n", ""));
            }
        }
        out.push_str(&format!("{:<30} {:>16} {:>16}\n", "total", Money::new(debits, self.currency), Money::new(credits, self.currency)));
        out
    }

    fn title(&self) -> &str {
        "trial balance"
    }
}

/// `account,currency,minor` rows, for a spreadsheet.
pub struct CsvReport {
    pub currencies: Vec<Currency>,
}

impl Report for CsvReport {
    fn render(&self, ledger: &Ledger) -> String {
        let mut out = String::from("account,currency,minor\n");
        for currency in &self.currencies {
            for (name, raw) in ledger.trial_balance(*currency) {
                out.push_str(&format!("{},{},{}\n", quote(&name), currency.code(), raw));
            }
        }
        out
    }
}

/// A CSV field, quoted when it holds a comma or a quote.
fn quote(field: &str) -> String {
    if field.contains(',') || field.contains('"') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}
