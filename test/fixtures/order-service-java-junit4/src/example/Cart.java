package example;

import java.util.List;

public class Cart {
    public record Item(String sku, int quantity, int unitPrice) {}

    public static int subtotal(List<Item> items) {
        int total = 0;
        for (Item item : items) total += item.unitPrice() * item.quantity();
        return total;
    }

    /** Take a percentage off a total. A discount of 100 percent or more makes the order free. */
    public static int applyDiscount(int total, int percent) {
        if (percent >= 100) return 0;
        return total - total * percent / 100;
    }
}
