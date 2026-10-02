package io.tallyho.billing.domain;

import java.math.BigDecimal;

/** Where a customer is taxed, and the standard rate there. */
public enum TaxRegion {
    US_CA("0.0725", false),
    US_OR("0", false),
    EU_DE("0.19", true),
    EU_FR("0.20", true),
    EU_IE("0.23", true),
    UK("0.20", false);

    private final BigDecimal rate;
    private final boolean eu;

    TaxRegion(String rate, boolean eu) {
        this.rate = new BigDecimal(rate);
        this.eu = eu;
    }

    public BigDecimal rate() {
        return rate;
    }

    public boolean isEu() {
        return eu;
    }
}
