use relcheck_cli::Lockfile;
use relcheck_core::{Version, VersionReq};

#[test]
fn reads_pins_and_skips_comments() {
    let lock = Lockfile::parse("# deps\nserde ^1.0 = 1.0.197 # pinned for msrv\n\nlog ^0.4 = 0.4.21\n").unwrap();
    assert_eq!(lock.pins.len(), 2);
    let serde = lock.get("serde").unwrap();
    assert_eq!(serde.locked, Version::new(1, 0, 197));
    assert_eq!(serde.req, VersionReq::parse("^1.0").unwrap());
}

#[test]
fn a_line_without_a_lock_names_its_number() {
    assert_eq!(Lockfile::parse("serde ^1.0 = 1.0.0\nlog ^0.4\n"), Err("line 2: no '='".to_string()));
}

#[test]
fn finds_pins_the_manifest_outgrew() {
    let lock = Lockfile::parse("tokio ^1.36 = 1.35.1\nbytes ^1 = 1.5.0\n").unwrap();
    let stale: Vec<&str> = lock.stale().iter().map(|pin| pin.name.as_str()).collect();
    assert_eq!(stale, vec!["tokio"]);
}
