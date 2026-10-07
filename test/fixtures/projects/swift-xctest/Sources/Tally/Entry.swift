public enum Side { case debit, credit }

/// One line of a journal entry: an amount on one side of one account.
public struct Line: Equatable {
    public let account: String
    public let side: Side
    public let amount: Money
}

public enum EntryError: Error, Equatable {
    case tooFewLines
    case unbalanced(Money)
}

/// A dated set of lines whose debits must equal their credits before it is posted.
public struct Entry {
    public let memo: String
    public private(set) var lines: [Line] = []

    public init(memo: String) {
        self.memo = memo
    }

    public func debit(_ account: String, _ amount: Money) -> Entry {
        var copy = self
        copy.lines.append(Line(account: account, side: .debit, amount: amount))
        return copy
    }

    public func credit(_ account: String, _ amount: Money) -> Entry {
        var copy = self
        copy.lines.append(Line(account: account, side: .credit, amount: amount))
        return copy
    }

    /// Debits less credits, which a balanced entry makes zero.
    public func imbalance() throws -> Money {
        guard let first = lines.first else { throw EntryError.tooFewLines }
        var total = Money.zero(first.amount.currency)
        for line in lines {
            total = try total.plus(line.side == .debit ? line.amount : line.amount.negated())
        }
        return total
    }

    public func isBalanced() -> Bool {
        guard lines.count >= 2, let off = try? imbalance() else { return false }
        return off.isZero
    }

    public func validate() throws {
        if lines.count < 2 { throw EntryError.tooFewLines }
        let off = try imbalance()
        if !off.isZero { throw EntryError.unbalanced(off) }
    }
}
