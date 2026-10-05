package com.northwind.warehouse.stock;

import com.northwind.warehouse.model.Location;
import com.northwind.warehouse.model.Sku;
import com.northwind.warehouse.model.StockLevel;
import java.util.Map;

/** Where stock levels are kept, by SKU and location. */
public interface StockRepository {
    /** The SKU's level at every location that has ever held it, in location order. */
    Map<Location, StockLevel> locationsOf(Sku sku);

    StockLevel levelAt(Sku sku, Location location);
}
