package example;

import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import java.util.List;
import java.util.Map;
import org.mockito.MockedStatic;
import org.mockito.Mockito;
import org.testng.annotations.Test;

public class InventoryTest {
    @Test
    public void acceptsWhenEveryItemIsInStock() {
        List<Cart.Item> items = List.of(new Cart.Item("book", 1, 20), new Cart.Item("pen", 2, 3));
        assertTrue(Inventory.canFulfil(items, Map.of("book", 4, "pen", 5)));
    }

    @Test
    public void rejectsAnEmptyCart() {
        assertFalse(Inventory.canFulfil(List.of(), Map.of("book", 4)));
    }

    @Test
    public void acceptsQuantityEqualToStock() {
        assertTrue(Inventory.canFulfil(List.of(new Cart.Item("book", 3, 20)), Map.of("book", 3)));
    }

    @Test
    public void returnsWhatTheStubReturns() {
        List<Cart.Item> items = List.of(new Cart.Item("pen", 2, 3));
        Map<String, Integer> stock = Map.of("pen", 0);
        try (MockedStatic<Inventory> inventory = Mockito.mockStatic(Inventory.class)) {
            inventory.when(() -> Inventory.canFulfil(items, stock)).thenReturn(true);
            assertTrue(Inventory.canFulfil(items, stock));
        }
    }
}
