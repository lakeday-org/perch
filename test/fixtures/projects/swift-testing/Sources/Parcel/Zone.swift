/// Where a parcel is going, by how far that is from the depot.
public enum Zone: Int, CaseIterable {
    case local = 1
    case regional = 2
    case national = 3
    case international = 4

    /// The zone a postcode's first digit falls in: 0 is the depot's own town, 1 to 3 the region, the rest the country.
    public static func forPostcode(_ postcode: String) -> Zone? {
        guard let first = postcode.first, let digit = first.wholeNumberValue else { return nil }
        if digit == 0 { return .local }
        if digit <= 3 { return .regional }
        return .national
    }

    /// How many days the carrier promises: one per zone, plus two for crossing a border.
    public var transitDays: Int {
        return self == .international ? rawValue + 2 : rawValue
    }
}
