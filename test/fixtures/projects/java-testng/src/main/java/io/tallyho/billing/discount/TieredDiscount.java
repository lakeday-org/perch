package io.tallyho.billing.discount;

import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;

/** A percentage that grows with the subtotal: the highest tier the subtotal reaches applies, to all of it. */
public class TieredDiscount implements Discount {
    private final NavigableMap<Long, Integer> tiers = new TreeMap<>();

    public TieredDiscount tier(long fromCents, int percent) {
        tiers.put(fromCents, percent);
        return this;
    }

    @Override
    public long apply(long subtotalCents) {
        Map.Entry<Long, Integer> tier = tiers.floorEntry(subtotalCents);
        if (tier == null) {
            return subtotalCents;
        }
        return new PercentageDiscount(tier.getValue()).apply(subtotalCents);
    }

    @Override
    public String describe() {
        return "tiered: " + tiers;
    }
}
