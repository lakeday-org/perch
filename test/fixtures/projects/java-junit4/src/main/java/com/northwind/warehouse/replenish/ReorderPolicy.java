package com.northwind.warehouse.replenish;

/**
 * When to reorder a SKU and how much: reorder once what is available falls to the demand expected over the supplier's lead time
 * plus a safety stock, and order enough to cover a review period on top, rounded up to whole cases.
 */
public class ReorderPolicy {
    private final double dailyDemand;
    private final int leadTimeDays;
    private final int safetyStock;
    private final int caseSize;

    public ReorderPolicy(double dailyDemand, int leadTimeDays, int safetyStock, int caseSize) {
        if (caseSize < 1) {
            throw new IllegalArgumentException("case size must be at least 1");
        }
        this.dailyDemand = dailyDemand;
        this.leadTimeDays = leadTimeDays;
        this.safetyStock = safetyStock;
        this.caseSize = caseSize;
    }

    public int reorderPoint() {
        return (int) Math.ceil(dailyDemand * leadTimeDays) + safetyStock;
    }

    public boolean shouldReorder(int available, int onOrder) {
        return available + onOrder <= reorderPoint();
    }

    public int orderQuantity(int available, int onOrder, int reviewDays) {
        if (!shouldReorder(available, onOrder)) {
            return 0;
        }
        int target = reorderPoint() + (int) Math.ceil(dailyDemand * reviewDays);
        int needed = target - available - onOrder;
        int cases = (needed + caseSize - 1) / caseSize;
        return cases * caseSize;
    }
}
