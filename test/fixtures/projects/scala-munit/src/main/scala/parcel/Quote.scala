package parcel

import parcel.rates.RateCard

final class UnknownDestination(postcode: String) extends IllegalArgumentException(s"no zone for $postcode")
final class NoRate(zone: Zone, grams: Int) extends IllegalArgumentException(s"no rate for $grams g to $zone")

final case class Quote(zone: Zone, cents: Int, transitDays: Int) {
  /** The price with a surcharge in percent added, rounded to the cent. */
  def surcharged(percent: Int): Int = cents + (cents * percent + 50) / 100
}

/** Prices a parcel to a postcode off a rate card. */
final class Quoter(card: RateCard = RateCard.standard) {
  def quote(parcel: Parcel, postcode: String): Quote = {
    parcel.validate()
    val zone = Zone.forPostcode(postcode).getOrElse(throw new UnknownDestination(postcode))
    val grams = parcel.billableGrams
    val cents = card.cents(grams, zone).getOrElse(throw new NoRate(zone, grams))
    Quote(zone, cents, zone.transitDays)
  }

  /** The cheapest of several parcels' quotes, or None when none can be shipped. */
  def cheapest(parcels: List[Parcel], postcode: String): Option[Quote] =
    parcels.flatMap(parcel => scala.util.Try(quote(parcel, postcode)).toOption).minByOption(_.cents)
}
