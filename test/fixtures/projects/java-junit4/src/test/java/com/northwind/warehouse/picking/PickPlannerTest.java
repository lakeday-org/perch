package com.northwind.warehouse.picking;

import static org.junit.Assert.assertEquals;

import com.northwind.warehouse.model.Location;
import com.northwind.warehouse.model.Sku;
import com.northwind.warehouse.notify.LowStockAlerter;
import com.northwind.warehouse.order.Order;
import com.northwind.warehouse.stock.InMemoryStockRepository;
import com.northwind.warehouse.stock.InsufficientStockException;
import com.northwind.warehouse.stock.StockService;
import java.time.Clock;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.mockito.Mockito;

public class PickPlannerTest {
    private static final Location DISPATCH = Location.parse("A01-S1-B01");
    private PickPlanner planner;

    @Before
    public void stockTheWarehouse() {
        InMemoryStockRepository repository = new InMemoryStockRepository()
                .stock(Sku.parse("HDW-00001"), Location.parse("A04-S1-B10"), 50)
                .stock(Sku.parse("HDW-00002"), Location.parse("A01-S2-B06"), 50)
                .stock(Sku.parse("ELC-00001"), Location.parse("A02-S1-B03"), 50);
        LowStockAlerter quiet = new LowStockAlerter(Mockito.mock(com.northwind.warehouse.notify.Notifier.class), Clock.systemUTC(), 0);
        planner = new PickPlanner(new StockService(repository, quiet), DISPATCH);
    }

    private static Order order() {
        return new Order("SO-1001", Order.Priority.STANDARD)
                .line("HDW-00001", 2)
                .line("HDW-00002", 30)
                .line("ELC-00001", 5);
    }

    @Test
    public void walksInLocationOrder() {
        PickList list = planner.plan(order(), PickStrategy.LOCATION_ORDER);
        assertEquals(List.of("A01-S2-B06", "A02-S1-B03", "A04-S1-B10"), locations(list));
    }

    @Test
    public void putsTheBiggestPickFirst() {
        PickList list = planner.plan(order(), PickStrategy.HEAVIEST_FIRST);
        assertEquals(30, list.lines().get(0).quantity());
    }

    @Test
    public void goesToTheNearestLineNext() {
        PickList list = planner.plan(order(), PickStrategy.NEAREST_NEXT);
        assertEquals("A01-S2-B06", list.lines().get(0).location().toString());
        assertEquals(37, list.units());
    }

    @Test
    public void measuresTheWalkThereAndBack() {
        PickList list = planner.plan(new Order("SO-1002", Order.Priority.EXPRESS).line("HDW-00002", 1), PickStrategy.LOCATION_ORDER);
        assertEquals(10, list.walkingDistance());
    }

    @Test(expected = InsufficientStockException.class)
    public void failsAnOrderTheWarehouseCannotFill() {
        planner.plan(new Order("SO-1003", Order.Priority.SAME_DAY).line("ELC-00001", 51), PickStrategy.LOCATION_ORDER);
    }

    @Test
    public void picksAStrategyByHowManyUnits() {
        assertEquals(PickStrategy.LOCATION_ORDER, PickStrategy.forUnits(5));
        assertEquals(PickStrategy.NEAREST_NEXT, PickStrategy.forUnits(80));
        assertEquals(PickStrategy.HEAVIEST_FIRST, PickStrategy.forUnits(500));
    }

    private static List<String> locations(PickList list) {
        return list.lines().stream().map(line -> line.location().toString()).toList();
    }
}
