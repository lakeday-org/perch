package com.northwind.warehouse.load;

import com.northwind.warehouse.model.Location;
import com.northwind.warehouse.order.Order;
import com.northwind.warehouse.picking.PickPlanner;
import com.northwind.warehouse.picking.PickStrategy;
import com.northwind.warehouse.stock.InMemoryStockRepository;
import com.northwind.warehouse.stock.StockService;
import com.northwind.warehouse.model.Sku;
import com.northwind.warehouse.notify.LowStockAlerter;
import java.time.Clock;
import java.util.Random;

/** Plans a day's worth of random orders against a stocked warehouse and prints how far the pickers walked. */
public final class LoadGenerator {
    private LoadGenerator() {
    }

    public static void main(String[] args) {
        int orders = args.length > 0 ? Integer.parseInt(args[0]) : 5_000;
        Random random = new Random(42);
        InMemoryStockRepository repository = new InMemoryStockRepository();
        for (int aisle = 1; aisle <= 12; aisle++) {
            for (int bin = 1; bin <= 30; bin++) {
                repository.stock(Sku.parse(String.format("HDW-%05d", aisle * 100 + bin)), new Location('A', aisle, 1, bin), 1_000);
            }
        }
        StockService stock = new StockService(repository, new LowStockAlerter((channel, message) -> { }, Clock.systemUTC(), 10));
        PickPlanner planner = new PickPlanner(stock, new Location('A', 1, 1, 1));
        long walked = 0;
        for (int i = 0; i < orders; i++) {
            Order order = new Order("LOAD-" + i, Order.Priority.STANDARD);
            for (int line = 0; line < 1 + random.nextInt(4); line++) {
                order.line(String.format("HDW-%05d", (1 + random.nextInt(12)) * 100 + 1 + random.nextInt(30)), 1 + random.nextInt(3));
            }
            walked += planner.plan(order, PickStrategy.forUnits(order.units())).walkingDistance();
        }
        System.out.println(orders + " orders, " + walked + " steps");
    }
}
