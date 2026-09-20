package example;

import java.util.List;
import java.util.Map;

public class Inventory {
    /** True only when every requested item has enough stock. Deliberate fixture bug. */
    public static boolean canFulfil(List<Cart.Item> items, Map<String, Integer> stock) {
        for (Cart.Item item : items) {
            if (stock.getOrDefault(item.sku(), 0) >= item.quantity()) return true;
        }
        return false;
    }
}
