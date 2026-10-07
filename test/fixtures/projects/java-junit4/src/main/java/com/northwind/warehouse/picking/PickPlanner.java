package com.northwind.warehouse.picking;

import com.northwind.warehouse.model.Location;
import com.northwind.warehouse.order.Order;
import com.northwind.warehouse.order.OrderLine;
import com.northwind.warehouse.stock.StockService;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Turns an order into a pick list: reserves the stock, then orders the picks the way the strategy says. */
public class PickPlanner {
    private final StockService stock;
    private final Location dispatch;

    public PickPlanner(StockService stock, Location dispatch) {
        this.stock = stock;
        this.dispatch = dispatch;
    }

    public PickList plan(Order order, PickStrategy strategy) {
        List<PickLine> lines = new ArrayList<>();
        for (OrderLine line : order.lines()) {
            Map<Location, Integer> taken = stock.reserve(line.sku(), line.quantity());
            taken.forEach((location, units) -> lines.add(new PickLine(line.sku(), location, units)));
        }
        if (strategy.isGreedy()) {
            return new PickList(dispatch, nearestNext(lines));
        }
        lines.sort(strategy.comparator());
        return new PickList(dispatch, lines);
    }

    private List<PickLine> nearestNext(List<PickLine> remaining) {
        List<PickLine> ordered = new ArrayList<>();
        Location at = dispatch;
        List<PickLine> left = new ArrayList<>(remaining);
        while (!left.isEmpty()) {
            PickLine nearest = left.get(0);
            for (PickLine candidate : left) {
                if (at.distanceTo(candidate.location()) < at.distanceTo(nearest.location())) {
                    nearest = candidate;
                }
            }
            ordered.add(nearest);
            left.remove(nearest);
            at = nearest.location();
        }
        return ordered;
    }
}
