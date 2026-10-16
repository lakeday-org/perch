public enum MoneyError: Error, Equatable {
    case malformed(String)
    case tooManyDecimals(String, Currency)
    case currencyMismatch(Currency, Currency)
}

/// An amount in minor units of one currency. Arithmetic across currencies throws rather than guessing a rate.
public struct Money: Equatable, Comparable {
    public let minor: Int
    public let currency: Currency

    public init(minor: Int, currency: Currency) {
        self.minor = minor
        self.currency = currency
    }

    public static func zero(_ currency: Currency) -> Money {
        return Money(minor: 0, currency: currency)
    }

    /// Parses "12.34" in a currency, rejecting more decimals than the currency keeps.
    public static func parse(_ text: String, _ currency: Currency) throws -> Money {
        let negative = text.hasPrefix("-")
        let parts = text.dropFirst(negative ? 1 : 0).split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2, let whole = Int(parts[0]) else { throw MoneyError.malformed(text) }
        let fraction = parts.count == 2 ? String(parts[1]) : ""
        if fraction.count > currency.decimals { throw MoneyError.tooManyDecimals(text, currency) }
        let padded = fraction.padding(toLength: currency.decimals, withPad: "0", startingAt: 0)
        let minor = whole * currency.scale + (padded.isEmpty ? 0 : Int(padded)!)
        return Money(minor: negative ? -minor : minor, currency: currency)
    }

    public func plus(_ other: Money) throws -> Money {
        if other.currency != currency { throw MoneyError.currencyMismatch(currency, other.currency) }
        return Money(minor: minor + other.minor, currency: currency)
    }

    public func negated() -> Money {
        return Money(minor: -minor, currency: currency)
    }

    /// Scales by a factor in percent, rounding half to even as a ledger does.
    public func times(percent: Int) -> Money {
        let scaled = Double(minor) * Double(percent) / 100
        return Money(minor: Int(scaled.rounded(.toNearestOrEven)), currency: currency)
    }

    public var isZero: Bool { return minor == 0 }

    public var isNegative: Bool { return minor < 0 }

    public static func < (lhs: Money, rhs: Money) -> Bool {
        return lhs.minor < rhs.minor
    }

    public func formatted() -> String {
        let magnitude = abs(minor)
        let whole = magnitude / currency.scale
        let fraction = magnitude % currency.scale
        var digits = String(fraction)
        while digits.count < currency.decimals { digits = "0" + digits }
        let tail = currency.decimals == 0 ? "" : "." + digits
        return (minor < 0 ? "-" : "") + currency.symbol + String(whole) + tail
    }
}
