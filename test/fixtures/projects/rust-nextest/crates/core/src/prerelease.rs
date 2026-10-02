use std::cmp::Ordering;
use std::fmt;

use crate::error::Error;

/// One dot-separated part of a prerelease: numeric parts compare as numbers and sort before alphanumeric ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identifier {
    Numeric(u64),
    Alpha(String),
}

impl Identifier {
    pub fn parse(text: &str) -> Result<Identifier, Error> {
        if text.is_empty() || !text.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(Error::BadPrerelease(text.to_string()));
        }
        if text.chars().all(|c| c.is_ascii_digit()) {
            if text.len() > 1 && text.starts_with('0') {
                return Err(Error::LeadingZero(text.to_string()));
            }
            return text.parse().map(Identifier::Numeric).map_err(|_| Error::BadPrerelease(text.to_string()));
        }
        Ok(Identifier::Alpha(text.to_string()))
    }
}

impl PartialOrd for Identifier {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Identifier {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Identifier::Numeric(a), Identifier::Numeric(b)) => a.cmp(b),
            (Identifier::Numeric(_), Identifier::Alpha(_)) => Ordering::Less,
            (Identifier::Alpha(_), Identifier::Numeric(_)) => Ordering::Greater,
            (Identifier::Alpha(a), Identifier::Alpha(b)) => a.cmp(b),
        }
    }
}

/// A version's prerelease, empty for a release. A release sorts after every prerelease of the same version.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Prerelease {
    pub identifiers: Vec<Identifier>,
}

impl Prerelease {
    pub fn parse(text: &str) -> Result<Prerelease, Error> {
        let identifiers = text.split('.').map(Identifier::parse).collect::<Result<Vec<_>, _>>()?;
        Ok(Prerelease { identifiers })
    }

    pub fn is_empty(&self) -> bool {
        self.identifiers.is_empty()
    }
}

impl PartialOrd for Prerelease {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Prerelease {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self.is_empty(), other.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => self.identifiers.cmp(&other.identifiers),
        }
    }
}

impl fmt::Display for Prerelease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, identifier) in self.identifiers.iter().enumerate() {
            if index > 0 {
                f.write_str(".")?;
            }
            match identifier {
                Identifier::Numeric(n) => write!(f, "{n}")?,
                Identifier::Alpha(s) => f.write_str(s)?,
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_identifiers_sort_before_alphanumeric() {
        assert!(Identifier::parse("11").unwrap() < Identifier::parse("alpha").unwrap());
        assert!(Identifier::parse("2").unwrap() < Identifier::parse("11").unwrap());
    }

    #[test]
    fn a_release_sorts_after_its_prereleases() {
        assert!(Prerelease::default() > Prerelease::parse("rc.1").unwrap());
    }

    #[test]
    fn rejects_a_leading_zero() {
        assert_eq!(Identifier::parse("01"), Err(Error::LeadingZero("01".into())));
    }
}
