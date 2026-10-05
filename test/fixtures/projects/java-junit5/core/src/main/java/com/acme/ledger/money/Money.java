package com.acme.ledger.money;

import java.math.BigDecimal;
import java.math.RoundingMode;

/** An amount in minor units of one currency. Arithmetic across currencies is refused, never converted silently. */
public record Money(long minor, Currency currency) implements Comparable<Money> {

    public Money {
        if (currency == null) {
            throw new IllegalArgumentException("currency is required");
        }
    }

    public static Money zero(Currency currency) {
        return new Money(0, currency);
    }

    public static Money of(String amount, Currency currency) {
        BigDecimal parsed = new BigDecimal(amount.trim());
        if (parsed.scale() > currency.decimals()) {
            throw new IllegalArgumentException(amount + " has more decimals than " + currency + " allows");
        }
        return new Money(parsed.movePointRight(currency.decimals()).longValueExact(), currency);
    }

    public Money plus(Money other) {
        requireSameCurrency(other);
        return new Money(Math.addExact(minor, other.minor), currency);
    }

    public Money minus(Money other) {
        requireSameCurrency(other);
        return new Money(Math.subtractExact(minor, other.minor), currency);
    }

    public Money negate() {
        return new Money(-minor, currency);
    }

    /** This amount times a rate, rounded half-even to the currency's minor unit. */
    public Money times(BigDecimal rate) {
        BigDecimal scaled = BigDecimal.valueOf(minor).multiply(rate).setScale(0, RoundingMode.HALF_EVEN);
        return new Money(scaled.longValueExact(), currency);
    }

    public boolean isZero() {
        return minor == 0;
    }

    public boolean isNegative() {
        return minor < 0;
    }

    @Override
    public int compareTo(Money other) {
        requireSameCurrency(other);
        return Long.compare(minor, other.minor);
    }

    private void requireSameCurrency(Money other) {
        if (other.currency != currency) {
            throw new IllegalArgumentException("cannot combine " + currency + " with " + other.currency);
        }
    }

    @Override
    public String toString() {
        BigDecimal major = BigDecimal.valueOf(minor).movePointLeft(currency.decimals());
        return currency.symbol() + major.toPlainString();
    }
}
