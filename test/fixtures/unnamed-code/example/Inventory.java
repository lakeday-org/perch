package example;

import java.util.Map;

// Everything here is inside a method, so the class around them is not code of its own.
public class Inventory {
    public boolean has(Map<String, Integer> stock, String sku) {
        return stock.getOrDefault(sku, 0) > 0;
    }
}
