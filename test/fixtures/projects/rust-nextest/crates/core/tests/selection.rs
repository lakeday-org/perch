use relcheck_core::{max_satisfying, newest_by_major, Version, VersionReq};

fn published() -> Vec<Version> {
    ["0.9.4", "1.0.0-rc.1", "1.0.0", "1.2.0", "1.4.2", "2.0.0-alpha.1", "2.0.0", "2.1.3"]
        .iter()
        .map(|text| text.parse().unwrap())
        .collect()
}

#[test]
fn picks_the_newest_match() {
    let versions = published();
    let req = VersionReq::parse("^1.1").unwrap();
    assert_eq!(max_satisfying(&versions, &req), Some(&Version::new(1, 4, 2)));
}

#[test]
fn nothing_matches_a_future_major() {
    let versions = published();
    assert_eq!(max_satisfying(&versions, &VersionReq::parse("^3").unwrap()), None);
}

#[test]
fn a_wildcard_skips_prereleases() {
    let versions = published();
    let req = relcheck_core::VersionReq::parse("*").unwrap();
    assert_eq!(max_satisfying(&versions, &req).unwrap().to_string(), "2.1.3");
}

#[test]
fn groups_releases_by_major() {
    let newest = newest_by_major(&published());
    assert_eq!(newest.keys().copied().collect::<Vec<_>>(), vec![0, 1, 2]);
    assert_eq!(newest[&2], Version::new(2, 1, 3));
}
