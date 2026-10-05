import XCTest
@testable import Tally

final class LedgerTests: XCTestCase {
    var ledger: Ledger!

    override func setUpWithError() throws {
        ledger = Ledger()
        _ = try ledger.open("1000", "Cash", .asset, .usd)
        _ = try ledger.open("4000", "Sales", .revenue, .usd)
    }

    private func sale(_ amount: Money) -> Entry {
        return Entry(memo: "sale").debit("1000", amount).credit("4000", amount)
    }

    func testPostingMovesBothBalances() throws {
        try ledger.post(sale(Money.parse("250", .usd)), on: 5)
        XCTAssertEqual(try ledger.balance("1000").formatted(), "$250.00")
        XCTAssertEqual(try ledger.balance("4000").formatted(), "$250.00")
        XCTAssertEqual(ledger.postedCount, 1)
    }

    func testPostingIntoAClosedPeriodIsRefused() throws {
        try ledger.closePeriod(through: 31)
        XCTAssertThrowsError(try ledger.post(sale(Money(minor: 100, currency: .usd)), on: 20)) { error in
            XCTAssertEqual(error as? LedgerError, .periodLocked(20))
        }
    }

    func testAFrozenAccountRefusesEntries() throws {
        try ledger.account("1000").freeze()
        XCTAssertThrowsError(try ledger.post(sale(Money(minor: 100, currency: .usd)), on: 5))
    }

    func testAPeriodCannotBeReopened() throws {
        try ledger.closePeriod(through: 31)
        XCTAssertThrowsError(try ledger.closePeriod(through: 28))
    }
}
