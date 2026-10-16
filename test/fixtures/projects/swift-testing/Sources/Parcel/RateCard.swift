/// The price of each weight band in each zone, in cents.
public struct RateCard {
    public struct Band: Equatable {
        public let upToGrams: Int
        public let cents: Int

        public init(upToGrams: Int, cents: Int) {
            self.upToGrams = upToGrams
            self.cents = cents
        }
    }

    private var bands: [Zone: [Band]] = [:]

    public init() {}

    public mutating func set(_ zone: Zone, _ zoneBands: [Band]) {
        bands[zone] = zoneBands.sorted { $0.upToGrams < $1.upToGrams }
    }

    /// The cents for a weight in a zone: the first band the weight fits under, or nil past the last.
    public func cents(for grams: Int, in zone: Zone) -> Int? {
        guard let zoneBands = bands[zone] else { return nil }
        for band in zoneBands where grams <= band.upToGrams {
            return band.cents
        }
        return nil
    }

    /// The standard card: four bands, each zone costing half again as much as the one before.
    public static func standard() -> RateCard {
        var card = RateCard()
        for zone in Zone.allCases {
            let factor = Double(zone.rawValue) * 0.5 + 0.5
            card.set(zone, [500, 2000, 5000, 30_000].enumerated().map { index, grams in
                Band(upToGrams: grams, cents: Int(Double(400 * (index + 1)) * factor))
            })
        }
        return card
    }
}
