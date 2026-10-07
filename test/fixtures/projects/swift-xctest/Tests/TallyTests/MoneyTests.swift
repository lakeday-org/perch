import XCTest
@testable import Tally

final class MoneyTests: XCTestCase {
    func testParsesDecimalStrings() throws {
        XCTAssertEqual(try Money.parse("12.34", .usd).minor, 1234)
        XCTAssertEqual(try Money.parse("0.5", .eur).minor, 50)
        XCTAssertEqual(try Money.parse("1500", .jpy).minor, 1500)
        XCTAssertEqual(try Money.parse("-7", .gbp).minor, -700)
    }

    func testRejectsMoreDecimalsThanTheCurrencyHas() {
        XCTAssertThrowsError(try Money.parse("1.234", Currency.usd)) { error in
            XCTAssertEqual(error as? MoneyError, .tooManyDecimals("1.234", .usd))
        }
    }

    func testRefusesToAddAcrossCurrencies() throws {
        let dollars = try Money.parse("1", .usd)
        let euros = try Money.parse("1", .eur)
        XCTAssertThrowsError(try dollars.plus(euros))
    }

    func testRoundsHalfToEven() {
        XCTAssertEqual(Money(minor: 5, currency: .usd).times(percent: 50).minor, 2)
        XCTAssertEqual(Money(minor: 7, currency: .usd).times(percent: 50).minor, 4)
    }

    func testFormatsANegativeAmountWithTheSignFirst() throws {
        let amount = try Money.parse("1.50", .usd)
        XCTAssertEqual(amount.negated().formatted(), "-$1.50")
    }

    func testFindsACurrencyByItsCode() {
        XCTAssertEqual(Currency.fromCode("eur"), .eur)
        XCTAssertNil(Currency.fromCode("XXX"))
    }
}
