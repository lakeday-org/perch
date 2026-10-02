use crate::currency::Currency;
use crate::entry::Entry;
use crate::error::LedgerError;
use crate::money::Money;

/// Read a journal: an entry is a dated header line followed by indented postings, and `;` starts a comment.
pub fn parse(text: &str) -> Result<Vec<Entry>, LedgerError> {
    let mut entries = Vec::new();
    let mut current: Option<Entry> = None;
    for (index, raw) in text.lines().enumerate() {
        let line_no = index + 1;
        let line = strip_comment(raw);
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with(char::is_whitespace) {
            let entry = current.as_mut().ok_or_else(|| LedgerError::Parse { line: line_no, message: "posting outside an entry".into() })?;
            let (account, amount) = parse_posting(line.trim(), line_no)?;
            entry.postings.push(crate::entry::Posting::new(account, amount));
        } else {
            if let Some(done) = current.take() {
                entries.push(done);
            }
            current = Some(parse_header(line, line_no)?);
        }
    }
    entries.extend(current);
    Ok(entries)
}

fn strip_comment(line: &str) -> &str {
    match line.find(';') {
        Some(at) => &line[..at],
        None => line,
    }
}

fn parse_header(line: &str, line_no: usize) -> Result<Entry, LedgerError> {
    let (date, memo) = line.split_once(' ').unwrap_or((line, ""));
    if date.len() != 10 || date.as_bytes()[4] != b'-' || date.as_bytes()[7] != b'-' {
        return Err(LedgerError::Parse { line: line_no, message: format!("{date} is not a date") });
    }
    Ok(Entry::new(date, memo.trim()))
}

fn parse_posting(line: &str, line_no: usize) -> Result<(&str, Money), LedgerError> {
    let mut words = line.split_whitespace();
    let account = words.next().ok_or_else(|| LedgerError::Parse { line: line_no, message: "empty posting".into() })?;
    let amount = words.next().ok_or_else(|| LedgerError::Parse { line: line_no, message: format!("{account} has no amount") })?;
    let code = words.next().unwrap_or("USD");
    let currency = Currency::from_code(code).ok_or_else(|| LedgerError::Parse { line: line_no, message: format!("unknown currency {code}") })?;
    let money = parse_amount(amount, currency).map_err(|message| LedgerError::Parse { line: line_no, message })?;
    Ok((account, money))
}

/// An amount written with the currency's decimals, `-12.05` or `1,200.00`, as minor units.
pub fn parse_amount(text: &str, currency: Currency) -> Result<Money, String> {
    let cleaned: String = text.chars().filter(|c| *c != ',').collect();
    let (negative, digits) = match cleaned.strip_prefix('-') {
        Some(rest) => (true, rest.to_string()),
        None => (false, cleaned),
    };
    let decimals = currency.decimals() as usize;
    let (whole, frac) = digits.split_once('.').unwrap_or((digits.as_str(), ""));
    if frac.len() > decimals {
        return Err(format!("{text} has more than {decimals} decimals"));
    }
    let whole: i64 = whole.parse().map_err(|_| format!("{text} is not a number"))?;
    let frac_padded = format!("{frac:0<decimals$}");
    let frac: i64 = if decimals == 0 { 0 } else { frac_padded.parse().map_err(|_| format!("{text} is not a number"))? };
    let minor = whole * 10_i64.pow(decimals as u32) + frac;
    Ok(Money::new(if negative { -minor } else { minor }, currency))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_trailing_comments() {
        assert_eq!(strip_comment("  assets:cash 5.00 ; tip"), "  assets:cash 5.00 ");
    }

    #[test]
    fn reads_thousands_separators() {
        assert_eq!(parse_amount("1,200.50", Currency::Usd).unwrap().minor(), 120050);
    }

    #[test]
    fn rejects_too_many_decimals() {
        assert!(parse_amount("1.005", Currency::Usd).is_err());
        assert!(parse_amount("10.5", Currency::Jpy).is_err());
    }

    #[test]
    fn a_header_needs_a_date() {
        assert!(parse_header("yesterday lunch", 3).is_err());
    }
}
