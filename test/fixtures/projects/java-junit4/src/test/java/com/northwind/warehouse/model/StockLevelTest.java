package com.northwind.warehouse.model;

import static org.junit.Assert.assertEquals;

import org.junit.Before;
import org.junit.Test;

public class StockLevelTest {
    private StockLevel level;

    @Before
    public void setUp() {
        level = new StockLevel(10);
    }

    @Test
    public void reservingReducesWhatIsAvailable() {
        level.reserve(4);
        assertEquals(6, level.available());
        assertEquals(10, level.onHand());
    }

    @Test(expected = IllegalStateException.class)
    public void cannotReserveMoreThanIsAvailable() {
        level.reserve(7);
        level.reserve(4);
    }

    @Test
    public void shippingTakesUnitsOffTheShelf() {
        level.reserve(3);
        level.ship(3);
        assertEquals(7, level.onHand());
        assertEquals(0, level.reserved());
    }

    @Test(expected = IllegalStateException.class)
    public void releasingMoreThanIsReservedIsRefused() {
        level.reserve(2);
        level.release(5);
    }
}
