package com.northwind.warehouse.order;

import com.northwind.warehouse.model.Sku;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** A customer order as the warehouse sees it: lines to pick, and a priority that decides which wave it goes in. */
public class Order {
    public enum Priority { STANDARD, EXPRESS, SAME_DAY }

    private final String number;
    private final Priority priority;
    private final List<OrderLine> lines = new ArrayList<>();

    public Order(String number, Priority priority) {
        this.number = number;
        this.priority = priority;
    }

    public Order line(String sku, int quantity) {
        lines.add(new OrderLine(Sku.parse(sku), quantity));
        return this;
    }

    public String number() {
        return number;
    }

    public Priority priority() {
        return priority;
    }

    public List<OrderLine> lines() {
        return Collections.unmodifiableList(lines);
    }

    public int units() {
        int total = 0;
        for (OrderLine line : lines) {
            total += line.quantity();
        }
        return total;
    }
}
