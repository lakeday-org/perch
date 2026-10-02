use std::fmt;

/// A calendar month, the unit reports are cut by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Period {
    pub year: i32,
    pub month: u32,
}

impl Period {
    pub fn new(year: i32, month: u32) -> Option<Period> {
        if (1..=12).contains(&month) {
            Some(Period { year, month })
        } else {
            None
        }
    }

    /// The month an ISO date `YYYY-MM-DD` falls in.
    pub fn from_date(date: &str) -> Option<Period> {
        let mut parts = date.split('-');
        let year = parts.next()?.parse().ok()?;
        let month = parts.next()?.parse().ok()?;
        let day: u32 = parts.next()?.parse().ok()?;
        if day == 0 || day > 31 {
            return None;
        }
        Period::new(year, month)
    }

    pub fn next(self) -> Period {
        if self.month == 12 {
            Period { year: self.year + 1, month: 1 }
        } else {
            Period { year: self.year, month: self.month + 1 }
        }
    }

    pub fn contains(self, date: &str) -> bool {
        Period::from_date(date) == Some(self)
    }
}

impl fmt::Display for Period {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}", self.year, self.month)
    }
}
