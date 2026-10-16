package com.northwind.warehouse.notify;

import com.northwind.warehouse.model.Sku;
import java.time.Clock;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.Map;

/** Tells purchasing when a SKU falls below its threshold, at most once a day per SKU. */
public class LowStockAlerter {
    private final Notifier notifier;
    private final Clock clock;
    private final int threshold;
    private final Map<Sku, LocalDate> lastAlerted = new HashMap<>();

    public LowStockAlerter(Notifier notifier, Clock clock, int threshold) {
        this.notifier = notifier;
        this.clock = clock;
        this.threshold = threshold;
    }

    /** Returns whether an alert went out. */
    public boolean check(Sku sku, int remaining) {
        if (remaining >= threshold) {
            return false;
        }
        LocalDate today = LocalDate.now(clock);
        if (today.equals(lastAlerted.get(sku))) {
            return false;
        }
        lastAlerted.put(sku, today);
        String level = remaining <= 0 ? "OUT OF STOCK" : "low";
        notifier.send("#purchasing", sku + " is " + level + ": " + remaining + " left");
        return true;
    }
}
