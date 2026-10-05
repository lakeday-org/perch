//! How long posting takes as a ledger grows. Run with `cargo bench`.

use std::hint::black_box;
use std::time::Instant;

use tiny_ledger::{Currency, Entry, Ledger, Money};

fn main() {
    for size in [1_000, 10_000, 100_000] {
        let mut ledger = Ledger::new();
        ledger.open("expenses:food").unwrap();
        ledger.open("assets:cash").unwrap();
        let started = Instant::now();
        for day in 0..size {
            let cents = 100 + (day % 900) as i64;
            let entry = Entry::new("2024-01-01", "meal")
                .with("expenses:food", Money::new(cents, Currency::Usd))
                .with("assets:cash", Money::new(-cents, Currency::Usd));
            ledger.post(black_box(entry)).unwrap();
        }
        let elapsed = started.elapsed();
        println!("{size:>7} entries: {:?} ({:?} each)", elapsed, elapsed / size as u32);
    }
}
