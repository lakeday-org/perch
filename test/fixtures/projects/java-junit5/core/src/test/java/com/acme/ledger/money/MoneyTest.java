package com.acme.ledger.money;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

class MoneyTest {

    @ParameterizedTest
    @CsvSource({
        "12.34, USD, 1234",
        "0.5, EUR, 50",
        "7, GBP, 700",
        "1500, JPY, 1500",
    })
    void parsesDecimalStrings(String amount, Currency currency, long minor) {
        assertEquals(minor, Money.of(amount, currency).minor());
    }

    @ParameterizedTest
    @ValueSource(strings = {"1.234", "0.001", "99.999"})
    void rejectsMoreDecimalsThanTheCurrencyHas(String amount) {
        assertThrows(IllegalArgumentException.class, () -> Money.of(amount, Currency.USD));
    }


    @Test
    void refusesToAddAcrossCurrencies() {
        Money dollars = Money.of("1", Currency.USD);
        Money euros = Money.of("1", Currency.EUR);
        assertThrows(IllegalArgumentException.class, () -> dollars.plus(euros));
    }

    @Test
    void roundsHalfToEven() {
        assertEquals(2, new Money(5, Currency.USD).times(new BigDecimal("0.5")).minor());
        assertEquals(4, new Money(7, Currency.USD).times(new BigDecimal("0.5")).minor());
    }

    @Test
    void formatsWithTheCurrencySymbol() {
        assertEquals("€12.50", Money.of("12.5", Currency.EUR).toString());
    }

    @Test
    void formatsANegativeAmountWithTheSignFirst() {
        assertEquals("-$1.50", Money.of("1.50", Currency.USD).negate().toString());
    }

    @Nested
    class Comparison {

        @Test
        void ordersByAmount() {
            assertTrue(Money.of("2", Currency.GBP).compareTo(Money.of("10", Currency.GBP)) < 0);
        }

        @Test
        void zeroIsNeitherNegativeNorNonZero() {
            Money zero = Money.zero(Currency.JPY);
            assertTrue(zero.isZero());
            assertFalse(zero.isNegative());
        }
    }
}
