/// How a fractional minor unit is settled when an amount is scaled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundingMode {
    HalfUp,
    HalfEven,
    Down,
}

/// `value * numerator / denominator`, rounded to a whole minor unit.
pub fn scale(value: i64, numerator: i64, denominator: i64, mode: RoundingMode) -> i64 {
    assert!(denominator > 0, "denominator must be positive");
    let product = value as i128 * numerator as i128;
    let quotient = product / denominator as i128;
    let remainder = product % denominator as i128;
    let twice = remainder.abs() * 2;
    let away = if product < 0 { -1 } else { 1 };
    let rounded = match mode {
        RoundingMode::Down => quotient,
        RoundingMode::HalfUp => {
            if twice >= denominator as i128 {
                quotient + away
            } else {
                quotient
            }
        }
        RoundingMode::HalfEven => {
            if twice > denominator as i128 || (twice == denominator as i128 && quotient % 2 != 0) {
                quotient + away
            } else {
                quotient
            }
        }
    };
    rounded as i64
}

/// A percentage of an amount, as tax and discounts are taken: half up.
pub fn percent_of(value: i64, basis_points: i64) -> i64 {
    scale(value, basis_points, 10_000, RoundingMode::HalfUp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_even_rounds_ties_to_even() {
        assert_eq!(scale(5, 1, 2, RoundingMode::HalfEven), 2);
        assert_eq!(scale(7, 1, 2, RoundingMode::HalfEven), 4);
    }

    #[test]
    fn half_up_rounds_ties_away_from_zero() {
        assert_eq!(scale(5, 1, 2, RoundingMode::HalfUp), 3);
        assert_eq!(scale(-5, 1, 2, RoundingMode::HalfUp), -3);
    }
}
