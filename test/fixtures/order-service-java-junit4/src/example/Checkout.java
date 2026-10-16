package example;

import java.util.List;
import java.util.Map;

public class Checkout {
    public static int placeOrder(List<Cart.Item> items, Map<String, Integer> stock) {
        if (!Inventory.canFulfil(items, stock)) throw new IllegalStateException("An item is out of stock");
        return Cart.subtotal(items);
    }
}
