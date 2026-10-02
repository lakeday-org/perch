use relcheck_core::{max_satisfying, Version, VersionReq};

use crate::args::Args;
use crate::lockfile::Lockfile;
use crate::output::{renderer, Row};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Pins a newer published release would still satisfy.
    Outdated,
    /// Whether a version satisfies a requirement.
    Check { req: String, version: String },
    /// The next version after a change of a kind: major, minor, or patch.
    Bump { version: String, kind: String },
}

/// Run a command against a lockfile and the versions a registry has published, returning what to print.
pub fn run(args: &Args, lockfile: &Lockfile, published: &dyn Fn(&str) -> Vec<Version>) -> Result<String, String> {
    match &args.command {
        Command::Outdated => {
            let mut rows = Vec::new();
            for pin in &lockfile.pins {
                let versions: Vec<Version> = published(&pin.name).into_iter().filter(|v| args.allow_pre || !v.is_prerelease()).collect();
                if let Some(latest) = max_satisfying(&versions, &pin.req) {
                    if *latest > pin.locked {
                        rows.push(Row { name: pin.name.clone(), current: pin.locked.to_string(), latest: latest.to_string() });
                    }
                }
            }
            Ok(renderer(args.format).render(&rows))
        }
        Command::Check { req, version } => {
            let req = VersionReq::parse(req).map_err(|e| e.to_string())?;
            let version = Version::parse(version).map_err(|e| e.to_string())?;
            Ok(if req.matches(&version) { format!("{version} satisfies {req}\n") } else { format!("{version} does not satisfy {req}\n") })
        }
        Command::Bump { version, kind } => {
            let version = Version::parse(version).map_err(|e| e.to_string())?;
            let next = match kind.as_str() {
                "major" => version.bump(true, false),
                "minor" => version.bump(false, true),
                "patch" => version.bump(false, false),
                other => return Err(format!("{other} is not major, minor, or patch")),
            };
            Ok(format!("{next}\n"))
        }
    }
}
