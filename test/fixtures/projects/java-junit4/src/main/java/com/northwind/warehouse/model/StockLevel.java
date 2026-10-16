package com.northwind.warehouse.model;

/** What one location holds of one SKU: units on hand, and how many of them are promised to orders. */
public class StockLevel {
    private int onHand;
    private int reserved;

    public StockLevel(int onHand) {
        if (onHand < 0) {
            throw new IllegalArgumentException("on hand cannot be negative");
        }
        this.onHand = onHand;
    }

    public int onHand() {
        return onHand;
    }

    public int reserved() {
        return reserved;
    }

    public int available() {
        return onHand - reserved;
    }

    public void reserve(int units) {
        if (units > available()) {
            throw new IllegalStateException("only " + available() + " available, asked for " + units);
        }
        reserved += units;
    }

    public void release(int units) {
        reserved -= units;
    }

    public void receive(int units) {
        if (units <= 0) {
            throw new IllegalArgumentException("receive a positive number of units");
        }
        onHand += units;
    }

    /** Takes reserved units off the shelf: they leave both on-hand and reserved. */
    public void ship(int units) {
        if (units > reserved) {
            throw new IllegalStateException("cannot ship " + units + ", only " + reserved + " reserved");
        }
        reserved -= units;
        onHand -= units;
    }
}
