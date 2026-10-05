package io.tallyho.billing.domain;

/** One billed thing: a description, how many, and the price of one in cents. */
public class LineItem {
    private final String description;
    private final int quantity;
    private final long unitCents;

    public LineItem(String description, int quantity, long unitCents) {
        if (quantity <= 0) {
            throw new IllegalArgumentException("quantity must be positive: " + quantity);
        }
        if (unitCents < 0) {
            throw new IllegalArgumentException("a line item cannot have a negative price; use a credit note");
        }
        this.description = description;
        this.quantity = quantity;
        this.unitCents = unitCents;
    }

    public String description() {
        return description;
    }

    public long subtotal() {
        return Math.multiplyExact(unitCents, quantity);
    }
}
