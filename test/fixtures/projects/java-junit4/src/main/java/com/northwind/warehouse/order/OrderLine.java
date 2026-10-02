package com.northwind.warehouse.order;

import com.northwind.warehouse.model.Sku;

public class OrderLine {
    private final Sku sku;
    private final int quantity;

    public OrderLine(Sku sku, int quantity) {
        if (quantity <= 0) {
            throw new IllegalArgumentException("quantity must be positive");
        }
        this.sku = sku;
        this.quantity = quantity;
    }

    public Sku sku() {
        return sku;
    }

    public int quantity() {
        return quantity;
    }
}
