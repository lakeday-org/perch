public enum ParcelError: Error, Equatable {
    case tooHeavy(grams: Int)
    case tooLong(centimetres: Int)
    case noWeight
}

/// What is being shipped: its weight and the three sides of its box.
public struct Parcel: Equatable {
    public let grams: Int
    public let sides: [Int]

    public init(grams: Int, sides: [Int]) {
        self.grams = grams
        self.sides = sides.sorted(by: >)
    }

    /// The girth a carrier charges by: the longest side plus twice the other two.
    public func girth() -> Int {
        guard sides.count == 3 else { return 0 }
        return sides[0] + 2 * (sides[1] + sides[2])
    }

    public var volumetricGrams: Int {
        guard sides.count == 3 else { return 0 }
        return sides[0] * sides[1] * sides[2] / 5
    }

    /// What the carrier weighs: the heavier of the scale weight and the volumetric weight.
    public func billableGrams() -> Int {
        return max(grams, volumetricGrams)
    }

    public func validate() throws {
        if grams <= 0 { throw ParcelError.noWeight }
        if grams > 30_000 { throw ParcelError.tooHeavy(grams: grams) }
        if let longest = sides.first, longest > 150 { throw ParcelError.tooLong(centimetres: longest) }
    }
}
