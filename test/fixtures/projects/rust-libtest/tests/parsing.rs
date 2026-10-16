use tiny_ledger::{Currency, Ledger, LedgerError, Period};

const MARCH: &str = "\
; household journal
2024-03-01 Rent
    expenses:rent      1,200.00 USD
    assets:checking   -1,200.00 USD

2024-03-15 Ramen in Tokyo
    expenses:food       1800 JPY ; with tip
    liabilities:visa   -1800 JPY
";

#[test]
fn parses_a_journal_into_entries() {
    let entries = tiny_ledger::parse(MARCH).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].memo, "Ramen in Tokyo");
    assert_eq!(entries[1].postings[0].amount.currency(), Currency::Jpy);
}

#[test]
fn a_parsed_journal_posts() {
    let mut ledger = Ledger::new();
    for name in ["expenses:rent", "assets:checking", "expenses:food", "liabilities:visa"] {
        ledger.open(name).unwrap();
    }
    ledger.post_all(tiny_ledger::parse(MARCH).unwrap()).unwrap();
    assert_eq!(ledger.balance("liabilities:visa", Currency::Jpy).unwrap().minor(), 1800);
}

#[test]
fn a_posting_before_any_header_names_its_line() {
    let err = tiny_ledger::parse("\n    assets:cash 1.00\n").unwrap_err();
    assert_eq!(err, LedgerError::Parse { line: 2, message: "posting outside an entry".into() });
}

#[test]
fn an_unknown_currency_is_a_parse_error() {
    let err = tiny_ledger::parse("2024-01-01 x\n    assets:cash 1.00 DOGE\n").unwrap_err();
    assert_eq!(err.to_string(), "line 2: unknown currency DOGE");
}

#[test]
fn entries_carry_their_month() {
    let entries = tiny_ledger::parse(MARCH).unwrap();
    assert_eq!(entries[0].period(), Period::new(2024, 3));
    assert_eq!(Period::new(2024, 12).unwrap().next(), Period::new(2025, 1).unwrap());
}
