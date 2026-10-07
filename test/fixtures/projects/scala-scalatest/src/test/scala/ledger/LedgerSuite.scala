package ledger

import ledger.money.{Currency, Money}
import org.scalatest.BeforeAndAfterEach
import org.scalatest.funsuite.AnyFunSuite

class LedgerSuite extends AnyFunSuite with BeforeAndAfterEach {
  private var ledger: Ledger = _

  override def beforeEach(): Unit = {
    ledger = Ledger.smallBusiness(Currency.USD)
  }

  private def sale(amount: Money): Entry = new Entry(5, "sale").debit("1000", amount).credit("4000", amount)

  test("posting moves both balances") {
    ledger.post(sale(Money.parse("250", Currency.USD)))
    assert(ledger.balance("1000").toString == "$250.00")
    assert(ledger.balance("4000").toString == "$250.00")
    assert(ledger.postedCount == 1)
  }

  test("posting into a closed period is refused") {
    ledger.closePeriod(31)
    intercept[IllegalStateException](ledger.post(sale(Money(100, Currency.USD))))
  }

  test("a frozen account refuses entries") {
    ledger.account("1000").freeze()
    intercept[FrozenAccountException](ledger.post(sale(Money(100, Currency.USD))))
  }

  test("a period cannot be reopened") {
    ledger.closePeriod(31)
    intercept[IllegalStateException](ledger.closePeriod(28))
  }

  test("a debit raises an asset and lowers revenue") {
    val cash = ledger.account("1000")
    cash.apply(Line("1000", Side.Debit, Money(500, Currency.USD)))
    assert(cash.currentBalance.minor == 500)
    assert(AccountType.Revenue.isDebitNormal == false)
  }
}
