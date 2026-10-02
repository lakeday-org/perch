package com.acme.ledger.fx;

import com.acme.ledger.money.Currency;
import java.math.BigDecimal;
import java.math.MathContext;
import java.time.LocalDate;
import java.util.EnumMap;
import java.util.Map;
import java.util.Optional;

/** Rates against one base currency that never change, as a test or a budget uses. */
public class FixedRates implements ExchangeRates {
    private final Currency base;
    private final Map<Currency, BigDecimal> perBase = new EnumMap<>(Currency.class);

    public FixedRates(Currency base) {
        this.base = base;
        perBase.put(base, BigDecimal.ONE);
    }

    public FixedRates with(Currency currency, String rate) {
        perBase.put(currency, new BigDecimal(rate));
        return this;
    }

    @Override
    public Optional<BigDecimal> rate(Currency from, Currency to, LocalDate on) {
        BigDecimal fromRate = perBase.get(from);
        BigDecimal toRate = perBase.get(to);
        if (fromRate == null || toRate == null) {
            return Optional.empty();
        }
        return Optional.of(toRate.divide(fromRate, MathContext.DECIMAL64));
    }

    public Currency base() {
        return base;
    }
}
