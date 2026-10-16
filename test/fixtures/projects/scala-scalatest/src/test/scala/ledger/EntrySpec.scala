package ledger

import ledger.money.{Currency, Money}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class EntrySpec extends AnyFlatSpec with Matchers {
  private val hundred = Money.parse("100", Currency.USD)

  "A balanced entry" should "validate" in {
    val entry = new Entry(1, "office chairs").debit("6100", hundred).credit("1000", hundred)
    entry.validate()
    entry.isBalanced shouldBe true
  }

  it should "report what it is off by when it is not" in {
    val entry = new Entry(1, "office chairs").debit("6100", hundred).credit("1000", Money.parse("90", Currency.USD))
    val error = intercept[UnbalancedEntryException](entry.validate())
    error.getMessage should include("$10.00")
  }

  "An entry with one line" should "not be balanced" in {
    val entry = new Entry(1, "office chairs").debit("6100", hundred)
    entry.isBalanced shouldBe false
    an[UnbalancedEntryException] should be thrownBy entry.validate()
  }
}
