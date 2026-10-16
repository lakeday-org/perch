package io.tallyho.billing.discount;

import java.util.Locale;

/** The discounts a promotion code stands for. */
public final class Discounts {
    private Discounts() {
    }

    public static Discount percent(int percent) {
        return new PercentageDiscount(percent);
    }

    /** 5% from $1,000, 10% from $5,000, 15% from $20,000. */
    public static Discount volume() {
        return new TieredDiscount().tier(100_000, 5).tier(500_000, 10).tier(2_000_000, 15);
    }

    /** SAVE10 is 10% off, SAVE25 is 25% off, VOLUME is the volume tiers. Anything else is not a code. */
    public static Discount fromCode(String code) {
        String normalized = code.trim().toUpperCase(Locale.ROOT);
        if (normalized.equals("VOLUME")) {
            return volume();
        }
        if (normalized.matches("SAVE\\d{1,2}")) {
            return percent(Integer.parseInt(normalized.substring(4)));
        }
        throw new IllegalArgumentException("unknown promotion code: " + code);
    }
}
