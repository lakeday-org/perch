package example;

import static org.testng.Assert.assertEquals;

import java.util.List;
import java.util.Map;
import org.testng.annotations.Test;

public class CheckoutTest {
    @Test
    public void placeOrderReturnsTheSubtotal() {
        List<Cart.Item> items = List.of(new Cart.Item("book", 1, 20), new Cart.Item("pen", 2, 3));
        assertEquals(Checkout.placeOrder(items, Map.of("book", 4, "pen", 5)), 26);
    }
}
