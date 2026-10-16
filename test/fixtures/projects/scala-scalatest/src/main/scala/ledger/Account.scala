package ledger

import ledger.money.{Currency, Money}

enum AccountType {
  case Asset, Liability, Equity, Revenue, Expense

  /** Assets and expenses grow with debits; the rest grow with credits. */
  def isDebitNormal: Boolean = this == AccountType.Asset || this == AccountType.Expense
}

final class FrozenAccountException(code: String) extends IllegalStateException(s"$code is frozen")

final class Account(val code: String, val name: String, val accountType: AccountType, currency: Currency) {
  require(code.nonEmpty, "an account needs a code")

  private var balance: Money = Money.zero(currency)
  private var frozen = false

  def currentBalance: Money = balance

  def freeze(): Unit = frozen = true

  /** Applies one side of an entry: a debit raises a debit-normal account and lowers the others. */
  def apply(line: Line): Unit = {
    if (frozen) throw new FrozenAccountException(code)
    val raises = (line.side == Side.Debit) == accountType.isDebitNormal
    balance = balance.plus(if (raises) line.amount else line.amount.negate)
  }
}
