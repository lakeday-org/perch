use tiny_ledger::{CsvReport, Currency, Entry, Ledger, Money, Report, TrialBalanceReport};

fn ledger_with_lunch() -> Ledger {
    let mut ledger = Ledger::new();
    ledger.open("expenses:food").unwrap();
    ledger.open("assets:cash").unwrap();
    ledger
        .post(Entry::new("2024-04-01", "lunch").with("expenses:food", Money::new(1250, Currency::Usd)).with("assets:cash", Money::new(-1250, Currency::Usd)))
        .unwrap();
    ledger
}

#[test]
fn trial_balance_totals_both_columns() {
    let report = TrialBalanceReport::new(Currency::Usd);
    let text = report.render(&ledger_with_lunch());
    let total = text.lines().last().unwrap();
    assert!(total.starts_with("total"));
    assert_eq!(total.matches("12.50 USD").count(), 2);
    assert_eq!(report.title(), "trial balance");
}

#[test]
fn csv_lists_one_row_per_account() {
    let report = CsvReport { currencies: vec![Currency::Usd, Currency::Eur] };
    let text = report.render(&ledger_with_lunch());
    assert_eq!(text, "account,currency,minor\nassets:cash,USD,-1250\nexpenses:food,USD,1250\n");
}
