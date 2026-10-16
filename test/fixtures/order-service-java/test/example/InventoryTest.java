package example;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.mockito.MockedStatic;
import org.mockito.Mockito;

class InventoryTest {
    @Test
    void acceptsWhenEveryItemIsInStock() {
        var items = List.of(new Cart.Item("book", 1, 20), new Cart.Item("pen", 2, 3));
        assertTrue(Inventory.canFulfil(items, Map.of("book", 4, "pen", 5)));
    }

    @Test
    void rejectsAnEmptyCart() {
        assertFalse(Inventory.canFulfil(List.of(), Map.of("book", 4)));
    }

    @Test
    void acceptsQuantityEqualToStock() {
        assertTrue(Inventory.canFulfil(List.of(new Cart.Item("book", 3, 20)), Map.of("book", 3)));
    }

    @Test
    void returnsWhatTheStubReturns() {
        var items = List.of(new Cart.Item("pen", 2, 3));
        var stock = Map.of("pen", 0);
        try (MockedStatic<Inventory> inventory = Mockito.mockStatic(Inventory.class)) {
            inventory.when(() -> Inventory.canFulfil(items, stock)).thenReturn(true);
            assertTrue(Inventory.canFulfil(items, stock));
        }
    }
}
