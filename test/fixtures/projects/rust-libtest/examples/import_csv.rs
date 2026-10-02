//! Read a bank's CSV export from stdin and print it as journal entries against assets:checking.
//!
//!     cargo run --example import_csv < statement.csv

use std::io::{self, BufRead};

use tiny_ledger::{parse_amount, Currency};

fn main() {
    let stdin = io::stdin();
    for line in stdin.lock().lines().skip(1) {
        let line = line.expect("reads stdin");
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() < 3 {
            eprintln!("skipping {line}");
            continue;
        }
        let amount = match parse_amount(fields[2], Currency::Usd) {
            Ok(amount) => amount,
            Err(message) => {
                eprintln!("{message}");
                continue;
            }
        };
        println!("{} {}", fields[0], fields[1]);
        println!("    expenses:uncategorized  {}", -amount);
        println!("    assets:checking         {}", amount);
        println!();
    }
}
