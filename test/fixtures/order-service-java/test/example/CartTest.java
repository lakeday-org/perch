package example;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class CartTest {
    @Test
    void takesTenPercentOff() {
        assertEquals(180, Cart.applyDiscount(200, 10));
    }

    @Test
    void takesTwentyPercentOff() {
        assertEquals(160, Cart.applyDiscount(200, 20));
    }

    @Test
    void takesTwentyFivePercentOff() {
        assertEquals(150, Cart.applyDiscount(200, 25));
    }

    @Test
    void takesFiftyPercentOff() {
        assertEquals(100, Cart.applyDiscount(200, 50));
    }

    @Test
    void takesSeventyFivePercentOff() {
        assertEquals(50, Cart.applyDiscount(200, 75));
    }

    @Test
    void addsUpTheCart() {
        Cart.subtotal(List.of(new Cart.Item("book", 1, 20), new Cart.Item("pen", 2, 3)));
    }

    @Test
    void matchesTheSavedOrderTotal() throws SQLException {
        String password = System.getenv("ORDERS_DB_PASSWORD");
        try (Connection connection = DriverManager.getConnection("jdbc:postgresql://localhost:5432/orders", "orders", password);
             PreparedStatement lines = connection.prepareStatement("select sku, quantity, unit_price from order_lines where order_id = ?");
             PreparedStatement order = connection.prepareStatement("select total from orders where id = ?")) {
            List<Cart.Item> items = new ArrayList<>();
            lines.setInt(1, 1);
            try (ResultSet rows = lines.executeQuery()) {
                while (rows.next()) items.add(new Cart.Item(rows.getString("sku"), rows.getInt("quantity"), rows.getInt("unit_price")));
            }
            order.setInt(1, 1);
            try (ResultSet row = order.executeQuery()) {
                assertTrue(row.next());
                assertEquals(row.getInt("total"), Cart.subtotal(items));
            }
        }
    }
}
