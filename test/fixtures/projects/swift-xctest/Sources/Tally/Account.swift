public enum AccountType {
    case asset, liability, equity, revenue, expense

    /// Assets and expenses grow with debits; the rest grow with credits.
    public var isDebitNormal: Bool {
        return self == .asset || self == .expense
    }
}

public enum AccountError: Error, Equatable {
    case frozen(String)
}

public final class Account {
    public let code: String
    public let name: String
    public let type: AccountType
    private var balance: Money
    private var frozen = false

    public init(code: String, name: String, type: AccountType, currency: Currency) {
        self.code = code
        self.name = name
        self.type = type
        self.balance = Money.zero(currency)
    }

    public func currentBalance() -> Money {
        return balance
    }

    public func freeze() {
        frozen = true
    }

    /// Applies one side of an entry: a debit raises a debit-normal account and lowers the others.
    public func apply(_ line: Line) throws {
        if frozen { throw AccountError.frozen(code) }
        let raises = (line.side == .debit) == type.isDebitNormal
        balance = try balance.plus(raises ? line.amount : line.amount.negated())
    }
}
