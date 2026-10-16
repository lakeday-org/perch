// Run with `scala-cli scripts/Seed.sc` against a published build: posts five demo sales and prints the cash balance. Not a test.
import ledger._
import ledger.money._

val book = Ledger.smallBusiness(Currency.USD)
for (day <- 1 to 5) {
  val amount = Money.parse((day * 100).toString, Currency.USD)
  book.post(new Entry(day, s"demo sale $day").debit("1000", amount).credit("4000", amount))
}
println(s"posted ${book.postedCount} entries; cash ${book.balance("1000")}")
