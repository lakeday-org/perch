package com.acme.ledger.fx;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.acme.ledger.money.Currency;
import com.acme.ledger.money.Money;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ConverterTest {
    private static final LocalDate MAR_1 = LocalDate.of(2026, 3, 1);
    private ExchangeRates rates;
    private Converter converter;

    @BeforeEach
    void setUp() {
        rates = mock(ExchangeRates.class);
        converter = new Converter(rates);
    }

    @Test
    void leavesAnAmountAlreadyInTheTargetCurrency() {
        Money amount = Money.of("10", Currency.USD);
        assertSame(amount, converter.convert(amount, Currency.USD, MAR_1));
        verifyNoInteractions(rates);
    }

    @Test
    void convertsAtTheDaysRate() {
        when(rates.rate(Currency.USD, Currency.EUR, MAR_1)).thenReturn(Optional.of(new BigDecimal("0.9")));
        assertEquals(Money.of("9.00", Currency.EUR), converter.convert(Money.of("10", Currency.USD), Currency.EUR, MAR_1));
    }

    @Test
    void convertsIntoACurrencyWithNoMinorUnit() {
        when(rates.rate(Currency.USD, Currency.JPY, MAR_1)).thenReturn(Optional.of(new BigDecimal("150")));
        assertEquals(Money.of("1500", Currency.JPY), converter.convert(Money.of("10", Currency.USD), Currency.JPY, MAR_1));
    }

    @Test
    void failsWhenThereIsNoRate() {
        when(rates.rate(any(), any(), any())).thenReturn(Optional.empty());
        assertThrows(IllegalStateException.class, () -> converter.convert(Money.of("1", Currency.GBP), Currency.USD, MAR_1));
    }

    @Test
    void crossesTwoCurrenciesThroughTheBase() {
        FixedRates fixed = new FixedRates(Currency.USD).with(Currency.EUR, "0.8").with(Currency.GBP, "0.5");
        Converter real = new Converter(fixed);
        assertEquals(Money.of("5.00", Currency.GBP), real.convert(Money.of("8", Currency.EUR), Currency.GBP, MAR_1));
    }
}
