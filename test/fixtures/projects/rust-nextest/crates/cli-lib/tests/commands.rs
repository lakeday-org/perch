use relcheck_cli::{run, Args, ArgsError, Lockfile};
use relcheck_core::Version;

const LOCK: &str = "\
# name requirement = locked
serde ^1.0 = 1.0.190
regex ~1.9 = 1.9.1
rand ^0.8 = 0.8.5
";

/// What the registry has published for each name the tests use.
fn registry(name: &str) -> Vec<Version> {
    let listed: &[&str] = match name {
        "serde" => &["1.0.190", "1.0.197", "2.0.0-alpha.1"],
        "regex" => &["1.9.1", "1.9.6", "1.10.0"],
        "rand" => &["0.8.5", "0.9.0"],
        _ => &[],
    };
    listed.iter().map(|text| relcheck_core::Version::parse(text).unwrap()).collect()
}

fn run_line(line: &str) -> Result<String, String> {
    let args = Args::parse(line.split_whitespace()).map_err(|e| e.to_string())?;
    run(&args, &Lockfile::parse(LOCK).unwrap(), &registry)
}

#[test]
fn outdated_lists_pins_with_a_newer_match() {
    let out = run_line("outdated").unwrap();
    assert!(out.contains("serde"));
    assert!(out.contains("1.0.197"));
    assert!(out.contains("1.9.6"));
    assert!(!out.contains("rand"));
}

#[test]
fn outdated_as_json() {
    let out = run_line("outdated --json").unwrap();
    assert!(out.starts_with("[{\"name\":\"serde\""));
}

#[test]
fn check_says_whether_a_version_satisfies() {
    assert_eq!(run_line("check ^1.2 1.4.0").unwrap(), "1.4.0 satisfies Caret 1.2.0\n");
    assert_eq!(run_line("check ~1.2 1.4.0").unwrap(), "1.4.0 does not satisfy Tilde 1.2.0\n");
}

#[test]
fn bump_minor_resets_the_patch() {
    assert_eq!(run_line("bump 1.4.7 minor").unwrap(), "1.5.0\n");
}

#[test]
fn bump_rejects_an_unknown_kind() {
    assert_eq!(run_line("bump 1.4.7 huge"), Err("huge is not major, minor, or patch".to_string()));
}

#[test]
fn an_unknown_flag_is_an_error() {
    assert_eq!(Args::parse(["outdated", "--verbose"]), Err(ArgsError::UnknownFlag("--verbose".into())));
}

#[test]
fn no_command_prints_usage() {
    let err = Args::parse(Vec::<String>::new()).unwrap_err();
    assert!(err.to_string().starts_with("usage: relcheck"));
}
