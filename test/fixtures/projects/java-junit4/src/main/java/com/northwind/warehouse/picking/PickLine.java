package com.northwind.warehouse.picking;

import com.northwind.warehouse.model.Location;
import com.northwind.warehouse.model.Sku;

/** Pick this many of a SKU from this location. */
public class PickLine {
    private final Sku sku;
    private final Location location;
    private final int quantity;

    public PickLine(Sku sku, Location location, int quantity) {
        this.sku = sku;
        this.location = location;
        this.quantity = quantity;
    }

    public Sku sku() {
        return sku;
    }

    public Location location() {
        return location;
    }

    public int quantity() {
        return quantity;
    }

    @Override
    public String toString() {
        return quantity + " x " + sku + " @ " + location;
    }
}
