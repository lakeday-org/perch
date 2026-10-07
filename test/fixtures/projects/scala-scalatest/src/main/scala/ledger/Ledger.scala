package ledger

import ledger.money._

/** The accounts and the entries posted to them, with a lock day before which nothing more may be posted. */
final class Ledger {
  private val accounts = scala.collection.mutable.Map.empty[String, Account]
  private val posted = scala.collection.mutable.ListBuffer.empty[Entry]
  private var lockedThrough: Option[Int] = None

  def open(code: String, name: String, accountType: AccountType, currency: Currency): Account = {
    if (accounts.contains(code)) throw new IllegalArgumentException(s"$code is already open")
    val account = new Account(code, name, accountType, currency)
    accounts(code) = account
    account
  }

  def account(code: String): Account =
    accounts.getOrElse(code, throw new NoSuchElementException(s"no account $code"))

  /** Posts an entry; one dated on or before the lock day is refused. */
  def post(entry: Entry): Unit = {
    if (lockedThrough.exists(entry.day <= _)) throw new IllegalStateException(s"day ${entry.day} is locked")
    entry.validate()
    entry.lines.foreach(line => account(line.account).apply(line))
    posted += entry
  }

  def balance(code: String): Money = account(code).currentBalance

  /** Closes the period through a day; a day before the current lock is refused. */
  def closePeriod(through: Int): Unit = {
    if (lockedThrough.exists(through < _)) throw new IllegalStateException("a period cannot be reopened")
    lockedThrough = Some(through)
  }

  def postedCount: Int = posted.size
}

object Ledger {
  /** A ledger with the small-business chart of accounts already open. */
  def smallBusiness(currency: Currency): Ledger = {
    val ledger = new Ledger
    ledger.open("1000", "Cash", AccountType.Asset, currency)
    ledger.open("4000", "Sales", AccountType.Revenue, currency)
    ledger.open("6100", "Office", AccountType.Expense, currency)
    ledger
  }
}
