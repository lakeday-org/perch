package com.acme.ledger.money;

import java.util.Locale;

/** The currencies the ledger books in, each with the number of minor units in a major one. */
public enum Currency {
    USD("$", 2),
    EUR("€", 2),
    GBP("£", 2),
    JPY("¥", 0);

    private final String symbol;
    private final int decimals;

    Currency(String symbol, int decimals) {
        this.symbol = symbol;
        this.decimals = decimals;
    }

    public String symbol() {
        return symbol;
    }

    public int decimals() {
        return decimals;
    }

    /** The currency an ISO 4217 code names, ignoring case and surrounding space. */
    public static Currency fromCode(String code) {
        if (code == null || code.isBlank()) {
            throw new IllegalArgumentException("currency code is empty");
        }
        String normalized = code.trim().toUpperCase(Locale.ROOT);
        for (Currency currency : values()) {
            if (currency.name().equals(normalized)) {
                return currency;
            }
        }
        throw new IllegalArgumentException("unknown currency: " + code);
    }
}
