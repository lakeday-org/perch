use std::cmp::Ordering;
use std::fmt;
use std::str::FromStr;

use crate::error::Error;
use crate::prerelease::Prerelease;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Prerelease,
}

impl Version {
    pub fn new(major: u64, minor: u64, patch: u64) -> Version {
        Version { major, minor, patch, pre: Prerelease::default() }
    }

    /// `1.2.3`, `1.2.3-rc.1`, or `v1.2.3`; build metadata after `+` is read and dropped.
    pub fn parse(text: &str) -> Result<Version, Error> {
        let text = text.trim();
        let text = text.strip_prefix('v').unwrap_or(text);
        if text.is_empty() {
            return Err(Error::Empty);
        }
        let text = text.split_once('+').map_or(text, |(core, _)| core);
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, Prerelease::parse(pre)?),
            None => (text, Prerelease::default()),
        };
        let parts: Vec<&str> = core.split('.').collect();
        if parts.len() != 3 {
            return Err(if parts.len() > 3 { Error::TooManyParts(core.to_string()) } else { Error::BadNumber { part: "patch", text: core.to_string() } });
        }
        Ok(Version { major: number(parts[0], "major")?, minor: number(parts[1], "minor")?, patch: number(parts[2], "patch")?, pre })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }

    /// The next version a change of this kind makes: a breaking change bumps the leftmost nonzero part.
    pub fn bump(&self, breaking: bool, feature: bool) -> Version {
        if breaking {
            if self.major > 0 {
                Version::new(self.major + 1, 0, 0)
            } else {
                Version::new(0, self.minor + 1, 0)
            }
        } else if feature {
            Version::new(self.major, self.minor + 1, 0)
        } else {
            Version::new(self.major, self.minor, self.patch + 1)
        }
    }
}

fn number(text: &str, part: &'static str) -> Result<u64, Error> {
    if text.len() > 1 && text.starts_with('0') {
        return Err(Error::LeadingZero(text.to_string()));
    }
    text.parse().map_err(|_| Error::BadNumber { part, text: text.to_string() })
}

impl FromStr for Version {
    type Err = Error;

    fn from_str(text: &str) -> Result<Version, Error> {
        Version::parse(text)
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)).then_with(|| self.pre.cmp(&other.pre))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if self.is_prerelease() {
            write!(f, "-{}", self.pre)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_prerelease_and_drops_build_metadata() {
        let version = Version::parse("v2.0.0-beta.3+sha.5114f85").unwrap();
        assert_eq!((version.major, version.minor, version.patch), (2, 0, 0));
        assert_eq!(version.to_string(), "2.0.0-beta.3");
    }

    #[test]
    fn rejects_four_parts() {
        assert_eq!(Version::parse("1.2.3.4"), Err(Error::TooManyParts("1.2.3.4".into())));
    }

    #[test]
    fn a_breaking_change_below_one_bumps_the_minor() {
        assert_eq!(Version::new(0, 4, 7).bump(true, false), Version::new(0, 5, 0));
        assert_eq!(Version::new(1, 4, 7).bump(true, false), Version::new(2, 0, 0));
    }

    #[test]
    fn a_fix_bumps_the_patch() {
        assert_eq!(Version::new(1, 4, 7).bump(false, false), Version::new(1, 4, 8));
    }
}
