package com.northwind.warehouse.stock;

import com.northwind.warehouse.model.Sku;

public class InsufficientStockException extends RuntimeException {
    private final Sku sku;
    private final int shortBy;

    public InsufficientStockException(Sku sku, int requested, int available) {
        super("need " + requested + " of " + sku + ", have " + available);
        this.sku = sku;
        this.shortBy = requested - available;
    }

    public Sku sku() {
        return sku;
    }

    public int shortBy() {
        return shortBy;
    }
}
