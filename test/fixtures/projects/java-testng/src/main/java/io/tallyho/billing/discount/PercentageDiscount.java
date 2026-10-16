package io.tallyho.billing.discount;

/** A whole-number percentage off, rounded down to the cent in the customer's favour. */
public class PercentageDiscount implements Discount {
    private final int percent;

    public PercentageDiscount(int percent) {
        if (percent <= 0 || percent >= 100) {
            throw new IllegalArgumentException("percent must be between 1 and 99: " + percent);
        }
        this.percent = percent;
    }

    @Override
    public long apply(long subtotalCents) {
        long off = subtotalCents * percent / 100;
        return subtotalCents - off;
    }

    @Override
    public String describe() {
        return percent + "% off";
    }
}
