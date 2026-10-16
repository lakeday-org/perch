package com.acme.ledger.fx;

import com.acme.ledger.money.Currency;
import com.acme.ledger.money.Money;
import java.math.BigDecimal;
import java.time.LocalDate;

/** Converts money between currencies at the rate for a day. */
public class Converter {
    private final ExchangeRates rates;

    public Converter(ExchangeRates rates) {
        this.rates = rates;
    }

    public Money convert(Money amount, Currency to, LocalDate on) {
        if (amount.currency() == to) {
            return amount;
        }
        BigDecimal rate = rates.rate(amount.currency(), to, on)
                .orElseThrow(() -> new IllegalStateException("no rate from " + amount.currency() + " to " + to + " on " + on));
        BigDecimal scale = BigDecimal.TEN.pow(to.decimals()).divide(BigDecimal.TEN.pow(amount.currency().decimals()));
        Money scaled = amount.times(rate.multiply(scale));
        return new Money(scaled.minor(), to);
    }
}
