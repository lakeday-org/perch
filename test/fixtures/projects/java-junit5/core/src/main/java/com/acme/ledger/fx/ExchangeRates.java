package com.acme.ledger.fx;

import com.acme.ledger.money.Currency;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Optional;

/** Where conversion rates come from: a rate service, a file, a fixed table. */
public interface ExchangeRates {
    Optional<BigDecimal> rate(Currency from, Currency to, LocalDate on);
}
