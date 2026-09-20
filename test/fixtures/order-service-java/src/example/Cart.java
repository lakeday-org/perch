package example;

import java.util.List;

public class Cart {
    public record Item(String sku, int quantity, int unitPrice) {}

    public static int subtotal(List<Item> items) {
        int total = 0;
        for (Item item : items) total += item.unitPrice() * item.quantity();
        return total;
    }
}
