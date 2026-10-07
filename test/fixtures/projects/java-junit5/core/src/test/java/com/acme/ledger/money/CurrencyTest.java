package com.acme.ledger.money;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

class CurrencyTest {

    @ParameterizedTest
    @CsvSource({"usd, USD", "' EUR ', EUR", "Gbp, GBP"})
    void findsACurrencyByItsCode(String code, Currency expected) {
        assertEquals(expected, Currency.fromCode(code));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "   ", "XYZ", "dollars"})
    void rejectsCodesItDoesNotBookIn(String code) {
        assertThrows(IllegalArgumentException.class, () -> Currency.fromCode(code));
    }
}
