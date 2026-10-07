package example;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import org.testng.annotations.Test;

/** Every public method of a class annotated with @Test is a TestNG test. */
@Test
public class CartTest {
    public void takesTenPercentOff() {
        assertEquals(Cart.applyDiscount(200, 10), 180);
    }

    public void takesTwentyPercentOff() {
        assertEquals(Cart.applyDiscount(200, 20), 160);
    }

    public void takesTwentyFivePercentOff() {
        assertEquals(Cart.applyDiscount(200, 25), 150);
    }

    public void takesFiftyPercentOff() {
        assertEquals(Cart.applyDiscount(200, 50), 100);
    }

    public void takesSeventyFivePercentOff() {
        assertEquals(Cart.applyDiscount(200, 75), 50);
    }

    public void addsUpTheCart() {
        Cart.subtotal(List.of(new Cart.Item("book", 1, 20), new Cart.Item("pen", 2, 3)));
    }

    public void matchesTheSavedOrderTotal() throws SQLException {
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
                assertEquals(Cart.subtotal(items), row.getInt("total"));
            }
        }
    }
}
