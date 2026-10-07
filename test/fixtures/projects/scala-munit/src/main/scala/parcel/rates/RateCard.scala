package parcel.rates

import parcel.Zone

/** The price of one weight band in cents. */
final case class Band(upToGrams: Int, cents: Int)

/** The price of each weight band in each zone. */
final class RateCard(private val bands: Map[Zone, List[Band]]) {
  def set(zone: Zone, zoneBands: List[Band]): RateCard =
    new RateCard(bands + (zone -> zoneBands.sortBy(_.upToGrams)))

  /** The cents for a weight in a zone: the first band the weight fits under, or None past the last. */
  def cents(grams: Int, zone: Zone): Option[Int] =
    bands.get(zone).flatMap(_.find(grams <= _.upToGrams)).map(_.cents)
}

object RateCard {
  def empty: RateCard = new RateCard(Map.empty)

  /** The standard card: four bands, each zone costing half again as much as the one before. */
  def standard: RateCard =
    Zone.values.foldLeft(empty) { (card, zone) =>
      val factor = zone.rank * 0.5 + 0.5
      card.set(zone, List(500, 2000, 5000, 30000).zipWithIndex.map { case (grams, index) =>
        Band(grams, (400 * (index + 1) * factor).toInt)
      })
    }
}
