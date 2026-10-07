public enum QuoteError: Error, Equatable {
    case unknownDestination(String)
    case noRate(Zone, grams: Int)
}

public struct Quote: Equatable {
    public let zone: Zone
    public let cents: Int
    public let transitDays: Int

    /// The price with a surcharge in percent added, rounded to the cent.
    public func surcharged(percent: Int) -> Int {
        return cents + (cents * percent + 50) / 100
    }
}

/// Prices a parcel to a postcode off a rate card.
public struct Quoter {
    public let card: RateCard

    public init(card: RateCard = RateCard.standard()) {
        self.card = card
    }

    public func quote(_ parcel: Parcel, to postcode: String) throws -> Quote {
        try parcel.validate()
        guard let zone = Zone.forPostcode(postcode) else { throw QuoteError.unknownDestination(postcode) }
        let grams = parcel.billableGrams()
        guard let cents = card.cents(for: grams, in: zone) else { throw QuoteError.noRate(zone, grams: grams) }
        return Quote(zone: zone, cents: cents, transitDays: zone.transitDays)
    }

    /// The cheapest of several parcels' quotes, or nil when none can be shipped.
    public func cheapest(_ parcels: [Parcel], to postcode: String) -> Quote? {
        var best: Quote? = nil
        for parcel in parcels {
            guard let quote = try? quote(parcel, to: postcode) else { continue }
            if best == nil || quote.cents < best!.cents { best = quote }
        }
        return best
    }
}
