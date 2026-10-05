package parcel

/** Where a parcel is going, by how far that is from the depot. */
enum Zone(val rank: Int) {
  case Local extends Zone(1)
  case Regional extends Zone(2)
  case National extends Zone(3)
  case International extends Zone(4)

  /** How many days the carrier promises: one per zone, plus two for crossing a border. */
  def transitDays: Int = if (this == Zone.International) rank + 2 else rank
}

object Zone {
  /** The zone a postcode's first digit falls in: 0 is the depot's own town, 1 to 3 the region, the rest the country. */
  def forPostcode(postcode: String): Option[Zone] =
    postcode.headOption.filter(_.isDigit).map(_.asDigit).map {
      case 0 => Zone.Local
      case digit if digit <= 3 => Zone.Regional
      case _ => Zone.National
    }
}
