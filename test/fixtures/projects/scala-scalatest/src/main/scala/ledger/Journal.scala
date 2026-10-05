package ledger

import ledger.money.Money

enum Side { case Debit, Credit }

/** One line of a journal entry: an amount on one side of one account. */
final case class Line(account: String, side: Side, amount: Money)

final class UnbalancedEntryException(message: String) extends IllegalStateException(message)

/** A dated set of lines whose debits must equal their credits before it is posted. */
final class Entry(val day: Int, val memo: String) {
  private val built = scala.collection.mutable.ListBuffer.empty[Line]

  def lines: List[Line] = built.toList

  def debit(account: String, amount: Money): Entry = {
    built += Line(account, Side.Debit, amount)
    this
  }

  def credit(account: String, amount: Money): Entry = {
    built += Line(account, Side.Credit, amount)
    this
  }

  /** Debits less credits, which a balanced entry makes zero. */
  def imbalance: Money = {
    if (built.isEmpty) throw new UnbalancedEntryException("an entry needs at least two lines")
    built.foldLeft(Money.zero(built.head.amount.currency)) { (total, line) =>
      total.plus(if (line.side == Side.Debit) line.amount else line.amount.negate)
    }
  }

  def isBalanced: Boolean = built.size >= 2 && imbalance.isZero

  def validate(): Unit = {
    if (built.size < 2) throw new UnbalancedEntryException("an entry needs at least two lines")
    val off = imbalance
    if (!off.isZero) throw new UnbalancedEntryException(s"entry is off by $off")
  }
}
