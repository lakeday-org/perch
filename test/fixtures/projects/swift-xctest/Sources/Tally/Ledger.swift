public enum LedgerError: Error, Equatable {
    case alreadyOpen(String)
    case noAccount(String)
    case periodLocked(Int)
    case cannotReopen
}

/// The accounts and the entries posted to them, with a lock day before which nothing more may be posted.
public final class Ledger {
    private var accounts: [String: Account] = [:]
    private var posted: [Entry] = []
    private var lockedThrough: Int? = nil

    public init() {}

    public func open(_ code: String, _ name: String, _ type: AccountType, _ currency: Currency) throws -> Account {
        if accounts[code] != nil { throw LedgerError.alreadyOpen(code) }
        let account = Account(code: code, name: name, type: type, currency: currency)
        accounts[code] = account
        return account
    }

    public func account(_ code: String) throws -> Account {
        guard let found = accounts[code] else { throw LedgerError.noAccount(code) }
        return found
    }

    /// Posts an entry dated by its day number; a day on or before the lock is refused.
    public func post(_ entry: Entry, on day: Int) throws {
        if let locked = lockedThrough, day <= locked { throw LedgerError.periodLocked(day) }
        try entry.validate()
        for line in entry.lines {
            try account(line.account).apply(line)
        }
        posted.append(entry)
    }

    public func balance(_ code: String) throws -> Money {
        return try account(code).currentBalance()
    }

    /// Closes the period through a day; a day before the current lock is refused.
    public func closePeriod(through day: Int) throws {
        if let locked = lockedThrough, day < locked { throw LedgerError.cannotReopen }
        lockedThrough = day
    }

    public var postedCount: Int { return posted.count }
}
