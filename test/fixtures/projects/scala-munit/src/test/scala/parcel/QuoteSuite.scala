package parcel

import munit.FunSuite
import parcel.rates.{Band, RateCard}

class QuoteSuite extends FunSuite {
  private var quoter: Quoter = _
  private val small = Parcel(400, List(10, 10, 10))

  override def beforeEach(context: BeforeEach): Unit = {
    quoter = new Quoter(RateCard.standard)
  }

  test("prices by zone and band") {
    val local = quoter.quote(small, "0100")
    val national = quoter.quote(small, "9100")
    assertEquals(local.cents, 400)
    assertEquals(national.cents, 800)
    assertEquals(national.transitDays, 3)
  }

  test("an unknown destination is refused") {
    intercept[UnknownDestination](quoter.quote(small, "XYZ"))
  }

  test("past the last band there is no rate") {
    val card = RateCard.empty.set(Zone.Local, List(Band(100, 100)))
    val limited = new Quoter(card)
    intercept[NoRate](limited.quote(small, "0100"))
  }

  test("surcharges round to the cent") {
    val quote = quoter.quote(small, "0100")
    assertEquals(quote.surcharged(0), 400)
    assertEquals(quote.surcharged(10), 440)
    assertEquals(quote.surcharged(3), 412)
  }

  test("cheapest skips what cannot ship") {
    val heavy = Parcel(40000, List(10, 10, 10))
    assertEquals(quoter.cheapest(List(heavy, small), "0100").map(_.cents), Some(400))
    assertEquals(quoter.cheapest(List(heavy), "0100"), None)
  }
}
