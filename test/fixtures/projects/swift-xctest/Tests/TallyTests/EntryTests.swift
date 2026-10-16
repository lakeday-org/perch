import XCTest
@testable import Tally

final class EntryTests: XCTestCase {
    let hundred = Money(minor: 10000, currency: .usd)
    var entry = Entry(memo: "office chairs")

    override func setUp() {
        super.setUp()
        entry = Entry(memo: "office chairs")
    }

    func testABalancedEntryValidates() throws {
        entry = entry.debit("6100", hundred).credit("1000", hundred)
        try entry.validate()
        XCTAssertTrue(entry.isBalanced())
    }

    func testAnUnbalancedEntryIsRefused() throws {
        entry = entry.debit("6100", hundred).credit("1000", try Money.parse("90", .usd))
        XCTAssertThrowsError(try entry.validate()) { error in
            XCTAssertEqual(error as? EntryError, .unbalanced(Money(minor: 1000, currency: .usd)))
        }
    }

    func testAnEntryNeedsTwoLines() {
        entry = entry.debit("6100", hundred)
        XCTAssertFalse(entry.isBalanced())
        XCTAssertThrowsError(try entry.validate())
    }
}
