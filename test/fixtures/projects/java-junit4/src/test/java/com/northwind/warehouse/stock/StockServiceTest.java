package com.northwind.warehouse.stock;

import static org.junit.Assert.assertEquals;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.northwind.warehouse.model.Location;
import com.northwind.warehouse.model.Sku;
import com.northwind.warehouse.notify.LowStockAlerter;
import java.util.Collections;
import java.util.Map;
import org.junit.Before;
import org.junit.Ignore;
import org.junit.Test;

public class StockServiceTest {
    private static final Sku HAMMER = Sku.parse("HDW-00412");
    private static final Location A1 = Location.parse("A01-S1-B01");
    private static final Location A2 = Location.parse("A02-S1-B01");

    private InMemoryStockRepository repository;
    private LowStockAlerter alerter;
    private StockService service;

    @Before
    public void setUp() {
        repository = new InMemoryStockRepository().stock(HAMMER, A1, 5).stock(HAMMER, A2, 8);
        alerter = mock(LowStockAlerter.class);
        service = new StockService(repository, alerter);
    }

    @Test
    public void addsUpWhatEveryLocationHasAvailable() {
        assertEquals(13, service.available(HAMMER));
    }

    @Test
    public void reservesFromTheFirstLocationThatHasEnough() {
        Map<Location, Integer> taken = service.reserve(HAMMER, 3);
        assertEquals(Collections.singletonMap(A1, 3), taken);
    }

    @Test
    public void spreadsAReservationAcrossLocations() {
        Map<Location, Integer> taken = service.reserve(HAMMER, 9);
        assertEquals(Integer.valueOf(5), taken.get(A1));
        assertEquals(Integer.valueOf(4), taken.get(A2));
        verify(alerter).check(HAMMER, 4);
    }

    @Test(expected = InsufficientStockException.class)
    public void refusesWhenEveryLocationTogetherIsShort() {
        service.reserve(HAMMER, 14);
    }

    @Test
    public void reservesNothingWhenItRefuses() {
        try {
            service.reserve(HAMMER, 20);
        } catch (InsufficientStockException expected) {
            assertEquals(7, expected.shortBy());
        }
        assertEquals(13, service.available(HAMMER));
        verify(alerter, never()).check(eq(HAMMER), anyInt());
    }

    @Test
    public void releasingAReservationMakesItAvailableAgain() {
        Map<Location, Integer> taken = service.reserve(HAMMER, 9);
        service.release(HAMMER, taken);
        assertEquals(13, service.available(HAMMER));
    }

    @Ignore("needs a repository that locks per SKU; tracked in WH-311")
    @Test
    public void twoReservationsAtOnceNeverOversell() throws Exception {
        Thread first = new Thread(() -> service.reserve(HAMMER, 10));
        Thread second = new Thread(() -> service.reserve(HAMMER, 10));
        first.start();
        second.start();
        first.join();
        second.join();
        assertEquals(3, service.available(HAMMER));
    }
}
