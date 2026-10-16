use tiny_ledger::{Currency, Entry, Ledger, LedgerError, Money};

fn usd(minor: i64) -> Money {
    Money::new(minor, Currency::Usd)
}

/// A ledger with a checking account, a credit card, and the accounts a month of spending touches.
fn household() -> Ledger {
    let mut ledger = Ledger::new();
    for name in ["assets:checking", "liabilities:visa", "expenses:rent", "expenses:food", "income:salary"] {
        ledger.open(name).expect("opens");
    }
    ledger
}

#[test]
fn posting_moves_money_between_accounts() {
    let mut ledger = household();
    ledger
        .post(Entry::new("2024-03-01", "rent").with("expenses:rent", usd(120000)).with("assets:checking", usd(-120000)))
        .unwrap();
    assert_eq!(ledger.balance("expenses:rent", Currency::Usd).unwrap(), usd(120000));
    assert_eq!(ledger.balance("assets:checking", Currency::Usd).unwrap(), usd(-120000));
}

#[test]
fn a_liability_reads_positive_when_owed() {
    let mut ledger = household();
    ledger
        .post(Entry::new("2024-03-02", "groceries").with("expenses:food", usd(8735)).with("liabilities:visa", usd(-8735)))
        .unwrap();
    assert_eq!(ledger.balance("liabilities:visa", Currency::Usd).unwrap(), usd(8735));
}

#[test]
fn an_unbalanced_entry_changes_nothing() {
    let mut ledger = household();
    let err = ledger
        .post(Entry::new("2024-03-03", "fat finger").with("expenses:food", usd(1000)).with("assets:checking", usd(-100)))
        .unwrap_err();
    assert!(matches!(err, LedgerError::Unbalanced { residual: 900, .. }));
    assert!(ledger.trial_balance(Currency::Usd).is_empty());
}

#[test]
fn posting_to_a_closed_account_fails() {
    let mut ledger = household();
    ledger.close("liabilities:visa").unwrap();
    let result = ledger.post(Entry::new("2024-03-04", "late charge").with("expenses:food", usd(500)).with("liabilities:visa", usd(-500)));
    assert_eq!(result, Err(LedgerError::UnknownAccount("liabilities:visa".into())));
}

#[test]
fn opening_an_account_twice_fails() {
    let mut ledger = household();
    assert_eq!(ledger.open("expenses:rent"), Err(LedgerError::DuplicateAccount("expenses:rent".into())));
}

#[test]
fn post_all_stops_at_the_first_failure() {
    let mut ledger = household();
    let entries = vec![
        Entry::new("2024-03-05", "pay").with("assets:checking", usd(400000)).with("income:salary", usd(-400000)),
        Entry::new("2024-03-06", "nowhere").with("expenses:travel", usd(100)).with("assets:checking", usd(-100)),
        Entry::new("2024-03-07", "never reached").with("expenses:food", usd(100)).with("assets:checking", usd(-100)),
    ];
    assert!(ledger.post_all(entries).is_err());
    assert_eq!(ledger.balance("income:salary", Currency::Usd).unwrap(), usd(400000));
}

#[test]
#[ignore = "needs a year of fixtures checked in under tests/data"]
fn a_full_year_reconciles() {
    let mut ledger = household();
    let journal = std::fs::read_to_string("tests/data/2023.journal").unwrap();
    ledger.post_all(tiny_ledger::parse(&journal).unwrap()).unwrap();
    assert_eq!(ledger.balance("assets:checking", Currency::Usd).unwrap(), usd(0));
}
