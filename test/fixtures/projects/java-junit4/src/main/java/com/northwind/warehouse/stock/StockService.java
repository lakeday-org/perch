package com.northwind.warehouse.stock;

import com.northwind.warehouse.model.Location;
import com.northwind.warehouse.model.Sku;
import com.northwind.warehouse.model.StockLevel;
import com.northwind.warehouse.notify.LowStockAlerter;
import java.util.LinkedHashMap;
import java.util.Map;

/** Reserves, releases and receives stock across every location a SKU is kept in. */
public class StockService {
    private final StockRepository repository;
    private final LowStockAlerter alerter;

    public StockService(StockRepository repository, LowStockAlerter alerter) {
        this.repository = repository;
        this.alerter = alerter;
    }

    public int available(Sku sku) {
        int total = 0;
        for (StockLevel level : repository.locationsOf(sku).values()) {
            total += level.available();
        }
        return total;
    }

    /**
     * Reserves units of a SKU, taking from each location in order until the request is met. Either the whole request is
     * reserved or none of it is.
     */
    public Map<Location, Integer> reserve(Sku sku, int units) {
        int have = available(sku);
        if (units > have) {
            throw new InsufficientStockException(sku, units, have);
        }
        Map<Location, Integer> taken = new LinkedHashMap<>();
        int remaining = units;
        for (Map.Entry<Location, StockLevel> entry : repository.locationsOf(sku).entrySet()) {
            if (remaining == 0) {
                break;
            }
            int take = Math.min(remaining, entry.getValue().available());
            if (take > 0) {
                entry.getValue().reserve(take);
                taken.put(entry.getKey(), take);
                remaining -= take;
            }
        }
        alerter.check(sku, have - units);
        return taken;
    }

    public void release(Sku sku, Map<Location, Integer> reservation) {
        for (Map.Entry<Location, Integer> entry : reservation.entrySet()) {
            repository.levelAt(sku, entry.getKey()).release(entry.getValue());
        }
    }

    public void receive(Sku sku, Location location, int units) {
        repository.levelAt(sku, location).receive(units);
    }
}
