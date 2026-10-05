package ledger.money

/** An amount in minor units of one currency. Arithmetic across currencies throws rather than guessing a rate. */
final case class Money(minor: Long, currency: Currency) extends Ordered[Money] {
  def plus(other: Money): Money = {
    if (other.currency != currency) throw new IllegalArgumentException(s"cannot add ${other.currency.code} to ${currency.code}")
    Money(minor + other.minor, currency)
  }

  def negate: Money = Money(-minor, currency)

  /** Scales by a factor, rounding half to even as a ledger does. */
  def times(factor: BigDecimal): Money =
    Money((BigDecimal(minor) * factor).setScale(0, BigDecimal.RoundingMode.HALF_EVEN).toLong, currency)

  def isZero: Boolean = minor == 0

  def isNegative: Boolean = minor < 0

  def compare(that: Money): Int = {
    if (that.currency != currency) throw new IllegalArgumentException("cannot compare across currencies")
    minor.compare(that.minor)
  }

  override def toString: String = {
    val magnitude = math.abs(minor)
    val whole = magnitude / currency.scale
    val fraction = magnitude % currency.scale
    val digits = if (currency.decimals == 0) "" else "." + fraction.toString.reverse.padTo(currency.decimals, '0').reverse
    (if (minor < 0) "-" else "") + currency.symbol + whole + digits
  }
}

object Money {
  def zero(currency: Currency): Money = Money(0, currency)

  /** Parses "12.34" in a currency, rejecting more decimals than the currency keeps. */
  def parse(text: String, currency: Currency): Money = {
    val negative = text.startsWith("-")
    val parts = text.stripPrefix("-").split('.')
    if (parts.length > 2 || parts.isEmpty) throw new NumberFormatException(s"not an amount: $text")
    val fraction = if (parts.length == 2) parts(1) else ""
    if (fraction.length > currency.decimals) throw new NumberFormatException(s"$text has more decimals than ${currency.code}")
    val whole = parts(0).toLong * currency.scale
    val minor = if (fraction.isEmpty) 0L else fraction.padTo(currency.decimals, '0').toLong
    Money(if (negative) -(whole + minor) else whole + minor, currency)
  }
}
