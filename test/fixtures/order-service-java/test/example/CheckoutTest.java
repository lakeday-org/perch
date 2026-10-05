package example;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CheckoutTest {
    @Test
    void placeOrderReturnsTheSubtotal() {
        var items = List.of(new Cart.Item("book", 1, 20), new Cart.Item("pen", 2, 3));
        assertEquals(26, Checkout.placeOrder(items, Map.of("book", 4, "pen", 5)));
    }
}
