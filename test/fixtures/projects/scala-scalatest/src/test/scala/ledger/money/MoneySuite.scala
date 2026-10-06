package ledger.money

import org.scalatest.funsuite.AnyFunSuite

class MoneySuite extends AnyFunSuite {
  test("parses decimal strings") {
    assert(Money.parse("12.34", Currency.USD).minor == 1234)
    assert(Money.parse("0.5", Currency.EUR).minor == 50)
    assert(Money.parse("1500", Currency.JPY).minor == 1500)
    assert(Money.parse("-7", Currency.GBP).minor == -700)
  }

  test("rejects more decimals than the currency has") {
    intercept[NumberFormatException](Money.parse("1.234", Currency.USD))
  }

  test("refuses to add across currencies") {
    val dollars = Money.parse("1", Currency.USD)
    val euros = Money.parse("1", Currency.EUR)
    intercept[IllegalArgumentException](dollars.plus(euros))
  }

  test("rounds half to even") {
    assert(Money(5, Currency.USD).times(BigDecimal("0.5")).minor == 2)
    assert(Money(7, Currency.USD).times(BigDecimal("0.5")).minor == 4)
  }

  test("formats a negative amount with the sign first") {
    assert(Money.parse("1.50", Currency.USD).negate.toString == "-$1.50")
  }

  test("finds a currency by its code") {
    assert(Currency.fromCode("eur") == Currency.EUR)
    intercept[IllegalArgumentException](Currency.fromCode("XXX"))
  }
}
