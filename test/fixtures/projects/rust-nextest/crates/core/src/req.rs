use std::fmt;

use crate::error::Error;
use crate::version::Version;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Exact,
    Greater,
    GreaterEq,
    Less,
    LessEq,
    Tilde,
    Caret,
}

impl Op {
    fn parse(text: &str) -> Result<(Op, &str), Error> {
        let ops = [(">=", Op::GreaterEq), ("<=", Op::LessEq), (">", Op::Greater), ("<", Op::Less), ("=", Op::Exact), ("~", Op::Tilde), ("^", Op::Caret)];
        for (symbol, op) in ops {
            if let Some(rest) = text.strip_prefix(symbol) {
                return Ok((op, rest.trim_start()));
            }
        }
        match text.chars().next() {
            Some(c) if c.is_ascii_digit() => Ok((Op::Caret, text)),
            _ => Err(Error::BadOperator(text.to_string())),
        }
    }
}

/// An operator and a version, where a missing minor or patch is a wildcard: `^1.2` is `^1.2.0`, `~1` is any 1.x.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comparator {
    pub op: Op,
    pub version: Version,
    pub given: usize,
}

impl Comparator {
    pub fn parse(text: &str) -> Result<Comparator, Error> {
        let (op, rest) = Op::parse(text.trim())?;
        let given = rest.split('-').next().unwrap_or(rest).split('.').count();
        let padded = match given {
            1 => format!("{rest}.0.0"),
            2 => format!("{rest}.0"),
            _ => rest.to_string(),
        };
        Ok(Comparator { op, version: Version::parse(&padded)?, given })
    }

    pub fn matches(&self, v: &Version) -> bool {
        let base = &self.version;
        match self.op {
            Op::Exact => v == base,
            Op::Greater => v > base,
            Op::GreaterEq => v >= base,
            Op::Less => v < base,
            Op::LessEq => v <= base,
            Op::Tilde => v >= base && v.major == base.major && (self.given == 1 || v.minor == base.minor),
            Op::Caret => {
                if v < base {
                    false
                } else if base.major > 0 || self.given == 1 {
                    v.major == base.major
                } else if base.minor > 0 || self.given == 2 {
                    v.major == 0 && v.minor == base.minor
                } else {
                    v.major == 0 && v.minor == 0 && v.patch == base.patch
                }
            }
        }
    }
}

/// Comparators that must all hold, written comma-separated: `>=1.2, <1.5`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionReq {
    pub comparators: Vec<Comparator>,
}

impl VersionReq {
    pub fn parse(text: &str) -> Result<VersionReq, Error> {
        if text.trim() == "*" {
            return Ok(VersionReq { comparators: Vec::new() });
        }
        let comparators = text.split(',').map(Comparator::parse).collect::<Result<Vec<_>, _>>()?;
        Ok(VersionReq { comparators })
    }

    /// Whether a version satisfies every comparator. A prerelease only matches a comparator that names the same version core.
    pub fn matches(&self, v: &Version) -> bool {
        if v.is_prerelease() && !self.comparators.iter().any(|c| c.version.is_prerelease() && (c.version.major, c.version.minor, c.version.patch) == (v.major, v.minor, v.patch)) {
            return false;
        }
        self.comparators.iter().all(|c| c.matches(v))
    }
}

impl fmt::Display for VersionReq {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.comparators.is_empty() {
            return f.write_str("*");
        }
        let parts: Vec<String> = self.comparators.iter().map(|c| format!("{:?} {}", c.op, c.version)).collect();
        f.write_str(&parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn a_bare_version_is_a_caret() {
        assert_eq!(Comparator::parse("1.2").unwrap().op, Op::Caret);
    }

    #[test]
    fn caret_below_one_holds_the_minor() {
        let req = VersionReq::parse("^0.4.1").unwrap();
        assert!(req.matches(&v("0.4.9")));
        assert!(!req.matches(&v("0.5.0")));
    }

    #[test]
    fn tilde_holds_the_minor() {
        let req = VersionReq::parse("~1.2.3").unwrap();
        assert!(req.matches(&v("1.2.9")));
        assert!(!req.matches(&v("1.3.0")));
    }

    #[test]
    fn a_range_needs_every_comparator() {
        let req = VersionReq::parse(">=1.2, <1.5").unwrap();
        assert!(req.matches(&v("1.4.0")));
        assert!(!req.matches(&v("1.5.0")));
    }

    #[test]
    fn prereleases_only_match_their_own_core() {
        let req = VersionReq::parse(">=1.0.0-rc.1").unwrap();
        assert!(req.matches(&v("1.0.0-rc.2")));
        assert!(!req.matches(&v("1.1.0-alpha")));
    }
}
