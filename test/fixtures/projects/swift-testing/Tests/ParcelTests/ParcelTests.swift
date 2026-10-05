import Testing
@testable import Parcel

@Suite("Parcel")
struct ParcelTests {
    @Test("girth is the longest side plus twice the others")
    func girth() {
        let box = Parcel(grams: 1000, sides: [20, 60, 30])
        #expect(box.girth() == 160)
    }

    @Test func billsTheHeavierOfScaleAndVolume() {
        let light = Parcel(grams: 500, sides: [50, 40, 30])
        #expect(light.billableGrams() == 12_000)
        let dense = Parcel(grams: 20_000, sides: [10, 10, 10])
        #expect(dense.billableGrams() == 20_000)
    }

    @Test("rejects what the carrier will not take", arguments: [
        (Parcel(grams: 0, sides: [10, 10, 10]), ParcelError.noWeight),
        (Parcel(grams: 30_001, sides: [10, 10, 10]), ParcelError.tooHeavy(grams: 30_001)),
        (Parcel(grams: 100, sides: [151, 10, 10]), ParcelError.tooLong(centimetres: 151)),
    ])
    func rejects(parcel: Parcel, error: ParcelError) {
        #expect(throws: error) { try parcel.validate() }
    }
}
