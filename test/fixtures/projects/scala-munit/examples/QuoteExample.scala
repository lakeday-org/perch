// `scala-cli examples/QuoteExample.scala -- <grams> <postcode>`: prints what the standard card charges. An example, not a test.
import parcel._

@main def quoteExample(grams: Int, postcode: String): Unit = {
  val parcel = Parcel(grams, List(30, 20, 10))
  try {
    val quote = new Quoter().quote(parcel, postcode)
    println(s"${quote.zone}: ${quote.cents} cents, ${quote.transitDays} days")
  } catch {
    case error: IllegalArgumentException => println(s"cannot quote: ${error.getMessage}")
  }
}
