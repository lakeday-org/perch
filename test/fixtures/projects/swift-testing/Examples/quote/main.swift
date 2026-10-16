// `swift run quote <grams> <postcode>`: prints what the standard card charges. An example of the library's use, not a test.
import Parcel

let arguments = CommandLine.arguments.dropFirst()
guard arguments.count == 2, let grams = Int(arguments.first!) else {
    print("usage: quote <grams> <postcode>")
    exit(2)
}
let parcel = Parcel(grams: grams, sides: [30, 20, 10])
do {
    let quote = try Quoter().quote(parcel, to: arguments.last!)
    print("\(quote.zone): \(quote.cents) cents, \(quote.transitDays) days")
} catch {
    print("cannot quote: \(error)")
    exit(1)
}
