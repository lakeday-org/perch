package parcel

sealed abstract class ParcelError(message: String) extends IllegalArgumentException(message)
final class TooHeavy(grams: Int) extends ParcelError(s"$grams g is over the 30 kg limit")
final class TooLong(centimetres: Int) extends ParcelError(s"$centimetres cm is over the 150 cm limit")
final class NoWeight extends ParcelError("a parcel weighs something")

/** What is being shipped: its weight and the three sides of its box, longest first. */
final case class Parcel(grams: Int, sides: List[Int]) {
  private val sorted = sides.sorted(Ordering[Int].reverse)

  /** The girth a carrier charges by: the longest side plus twice the other two. */
  def girth: Int = sorted match {
    case longest :: second :: third :: Nil => longest + 2 * (second + third)
    case _ => 0
  }

  def volumetricGrams: Int = if (sorted.size == 3) sorted.product / 5 else 0

  /** What the carrier weighs: the heavier of the scale weight and the volumetric weight. */
  def billableGrams: Int = math.max(grams, volumetricGrams)

  def validate(): Unit = {
    if (grams <= 0) throw new NoWeight
    if (grams > 30000) throw new TooHeavy(grams)
    sorted.headOption.filter(_ > 150).foreach(longest => throw new TooLong(longest))
  }
}
