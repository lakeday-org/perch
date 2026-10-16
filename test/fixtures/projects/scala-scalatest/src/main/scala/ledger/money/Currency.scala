package ledger.money

final case class Currency(code: String, symbol: String, decimals: Int) {
  /** 10 to the power of the currency's decimals: how many minor units make one major unit. */
  def scale: Long = math.pow(10, decimals).toLong
}

object Currency {
  val USD: Currency = Currency("USD", "$", 2)
  val EUR: Currency = Currency("EUR", "€", 2)
  val GBP: Currency = Currency("GBP", "£", 2)
  val JPY: Currency = Currency("JPY", "¥", 0)

  private val known = List(USD, EUR, GBP, JPY)

  /** The currency booked under a code, or an error for one the ledger does not book in. */
  def fromCode(code: String): Currency =
    known.find(_.code == code.toUpperCase).getOrElse(throw new IllegalArgumentException(s"unknown currency $code"))
}
