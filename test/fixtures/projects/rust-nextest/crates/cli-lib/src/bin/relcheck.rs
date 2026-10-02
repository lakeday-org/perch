use std::process::ExitCode;

use relcheck_cli::{run, Args, Lockfile};
use relcheck_core::Version;

fn main() -> ExitCode {
    let args = match Args::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    let lockfile = match std::fs::read_to_string("relcheck.lock").map_err(|e| e.to_string()).and_then(|text| Lockfile::parse(&text)) {
        Ok(lockfile) => lockfile,
        Err(error) => {
            eprintln!("relcheck.lock: {error}");
            return ExitCode::from(1);
        }
    };
    let index = std::env::var("RELCHECK_INDEX").unwrap_or_else(|_| "index".to_string());
    let published = |name: &str| -> Vec<Version> {
        std::fs::read_to_string(format!("{index}/{name}"))
            .map(|text| text.lines().filter_map(|line| Version::parse(line).ok()).collect())
            .unwrap_or_default()
    };
    match run(&args, &lockfile, &published) {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
