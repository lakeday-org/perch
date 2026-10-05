import Testing
@testable import Parcel

@Suite struct ZoneTests {
    @Test(arguments: [("0123", Zone.local), ("2000", Zone.regional), ("9000", Zone.national)])
    func zonesByFirstDigit(postcode: String, zone: Zone) {
        #expect(Zone.forPostcode(postcode) == zone)
    }

    @Test func aPostcodeWithoutADigitHasNoZone() {
        #expect(Zone.forPostcode("ABC") == nil)
    }

    @Test func crossingABorderAddsTwoDays() {
        #expect(Zone.international.transitDays == 6)
        #expect(Zone.local.transitDays == 1)
    }
}

@Suite("Quoting")
struct QuoteTests {
    let quoter = Quoter()
    let small = Parcel(grams: 400, sides: [10, 10, 10])

    @Test("prices by zone and band")
    func pricesByZoneAndBand() throws {
        let local = try quoter.quote(small, to: "0100")
        let national = try quoter.quote(small, to: "9100")
        #expect(local.cents == 400)
        #expect(national.cents == 800)
        #expect(national.transitDays == 3)
    }

    @Test func anUnknownDestinationIsRefused() {
        #expect(throws: QuoteError.unknownDestination("XYZ")) { try quoter.quote(small, to: "XYZ") }
    }

    @Test func pastTheLastBandThereIsNoRate() throws {
        var card = RateCard()
        card.set(.local, [RateCard.Band(upToGrams: 100, cents: 100)])
        let quoter = Quoter(card: card)
        #expect(throws: QuoteError.noRate(.local, grams: 400)) { try quoter.quote(small, to: "0100") }
    }

    @Test("surcharges round to the cent", arguments: [(0, 400), (10, 440), (3, 412)])
    func surcharges(percent: Int, cents: Int) throws {
        let quote = try quoter.quote(small, to: "0100")
        #expect(quote.surcharged(percent: percent) == cents)
    }

    @Test func cheapestSkipsWhatCannotShip() {
        let heavy = Parcel(grams: 40_000, sides: [10, 10, 10])
        let cheapest = quoter.cheapest([heavy, small], to: "0100")
        #expect(cheapest?.cents == 400)
        #expect(quoter.cheapest([heavy], to: "0100") == nil)
    }
}
