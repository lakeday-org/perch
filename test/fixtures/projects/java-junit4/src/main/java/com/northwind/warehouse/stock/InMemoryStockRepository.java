package com.northwind.warehouse.stock;

import com.northwind.warehouse.model.Location;
import com.northwind.warehouse.model.Sku;
import com.northwind.warehouse.model.StockLevel;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;

public class InMemoryStockRepository implements StockRepository {
    private final Map<Sku, TreeMap<Location, StockLevel>> levels = new HashMap<>();

    @Override
    public Map<Location, StockLevel> locationsOf(Sku sku) {
        TreeMap<Location, StockLevel> found = levels.get(sku);
        return found == null ? Collections.emptyMap() : Collections.unmodifiableMap(found);
    }

    @Override
    public StockLevel levelAt(Sku sku, Location location) {
        return levels.computeIfAbsent(sku, key -> new TreeMap<>()).computeIfAbsent(location, key -> new StockLevel(0));
    }

    /** Puts units on a shelf, as goods-in does. */
    public InMemoryStockRepository stock(Sku sku, Location location, int units) {
        levelAt(sku, location).receive(units);
        return this;
    }
}
