package example;

import java.util.List;
import java.util.Map;

public class Main {
    public static void main(String[] args) {
        var items = List.of(new Cart.Item("book", 1, 20), new Cart.Item("pen", 2, 3));
        var stock = Map.of("book", 4, "pen", 0);
        System.out.println("Accepted order total: " + Checkout.placeOrder(items, stock));
    }
}
