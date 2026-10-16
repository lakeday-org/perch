public struct Currency: Equatable, Hashable {
    public let code: String
    public let symbol: String
    public let decimals: Int

    public static let usd = Currency(code: "USD", symbol: "$", decimals: 2)
    public static let eur = Currency(code: "EUR", symbol: "€", decimals: 2)
    public static let gbp = Currency(code: "GBP", symbol: "£", decimals: 2)
    public static let jpy = Currency(code: "JPY", symbol: "¥", decimals: 0)

    static let known = [usd, eur, gbp, jpy]

    public init(code: String, symbol: String, decimals: Int) {
        self.code = code
        self.symbol = symbol
        self.decimals = decimals
    }

    /// The currency booked under a code, or nil for one the ledger does not book in.
    public static func fromCode(_ code: String) -> Currency? {
        let wanted = code.uppercased()
        return known.first { $0.code == wanted }
    }

    /// 10 to the power of the currency's decimals: how many minor units make one major unit.
    public var scale: Int {
        var result = 1
        for _ in 0..<decimals { result *= 10 }
        return result
    }
}
