use std::collections::BTreeMap;

use crate::req::VersionReq;
use crate::version::Version;

/// The newest version a requirement accepts.
pub fn max_satisfying<'a>(versions: &'a [Version], req: &VersionReq) -> Option<&'a Version> {
    versions.iter().filter(|v| req.matches(v)).max()
}

/// The oldest version a requirement accepts, as a minimal-versions build would pick.
pub fn min_satisfying<'a>(versions: &'a [Version], req: &VersionReq) -> Option<&'a Version> {
    versions.iter().filter(|v| req.matches(v)).min()
}

/// The newest release in each major line, prereleases left out.
pub fn newest_by_major(versions: &[Version]) -> BTreeMap<u64, Version> {
    let mut newest: BTreeMap<u64, Version> = BTreeMap::new();
    for version in versions.iter().filter(|v| !v.is_prerelease()) {
        match newest.get(&version.major) {
            Some(current) if current >= version => {}
            _ => {
                newest.insert(version.major, version.clone());
            }
        }
    }
    newest
}
