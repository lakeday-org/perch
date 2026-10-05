package example;

import static org.junit.Assert.assertEquals;

import java.util.List;
import java.util.Map;
import org.junit.Test;

public class CheckoutTest {
    @Test
    public void placeOrderReturnsTheSubtotal() {
        List<Cart.Item> items = List.of(new Cart.Item("book", 1, 20), new Cart.Item("pen", 2, 3));
        assertEquals(26, Checkout.placeOrder(items, Map.of("book", 4, "pen", 5)));
    }
}
