// Run with `swift Benchmarks/PostingBenchmark.swift` after a release build: times posting ten thousand entries. Not a test.
import Foundation
import Tally

let ledger = Ledger()
_ = try ledger.open("1000", "Cash", .asset, .usd)
_ = try ledger.open("4000", "Sales", .revenue, .usd)
let amount = Money(minor: 100, currency: .usd)
let started = Date()
for day in 1...10_000 {
    try ledger.post(Entry(memo: "bench").debit("1000", amount).credit("4000", amount), on: day)
}
print("posted \(ledger.postedCount) entries in \(Date().timeIntervalSince(started))s")
