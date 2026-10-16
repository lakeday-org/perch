package parcel

import munit.FunSuite

class ParcelSuite extends FunSuite {
  test("girth is the longest side plus twice the others") {
    assertEquals(Parcel(1000, List(20, 60, 30)).girth, 160)
  }

  test("bills the heavier of scale and volume") {
    assertEquals(Parcel(500, List(50, 40, 30)).billableGrams, 12000)
    assertEquals(Parcel(20000, List(10, 10, 10)).billableGrams, 20000)
  }

  test("rejects what the carrier will not take") {
    intercept[NoWeight](Parcel(0, List(10, 10, 10)).validate())
    intercept[TooHeavy](Parcel(30001, List(10, 10, 10)).validate())
    intercept[TooLong](Parcel(100, List(151, 10, 10)).validate())
  }

  test("zones by first digit".tag(new munit.Tag("fast"))) {
    assertEquals(Zone.forPostcode("0123"), Some(Zone.Local))
    assertEquals(Zone.forPostcode("2000"), Some(Zone.Regional))
    assertEquals(Zone.forPostcode("9000"), Some(Zone.National))
    assertEquals(Zone.forPostcode("ABC"), None)
  }
}
