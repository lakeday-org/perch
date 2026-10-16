use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Empty,
    BadNumber { part: &'static str, text: String },
    LeadingZero(String),
    BadPrerelease(String),
    BadOperator(String),
    TooManyParts(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Empty => f.write_str("empty version"),
            Error::BadNumber { part, text } => write!(f, "{part} version {text:?} is not a number"),
            Error::LeadingZero(text) => write!(f, "{text:?} has a leading zero"),
            Error::BadPrerelease(text) => write!(f, "{text:?} is not a prerelease identifier"),
            Error::BadOperator(text) => write!(f, "unknown operator {text:?}"),
            Error::TooManyParts(text) => write!(f, "{text:?} has more than three parts"),
        }
    }
}

impl std::error::Error for Error {}
