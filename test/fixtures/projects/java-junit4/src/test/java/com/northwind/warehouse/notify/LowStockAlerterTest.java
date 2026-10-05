package com.northwind.warehouse.notify;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import com.northwind.warehouse.model.Sku;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.Before;
import org.junit.Test;

public class LowStockAlerterTest {
    private static final Sku HAMMER = Sku.parse("HDW-00412");
    private Notifier notifier;
    private LowStockAlerter alerter;

    @Before
    public void setUp() {
        notifier = mock(Notifier.class);
        alerter = new LowStockAlerter(notifier, Clock.fixed(Instant.parse("2026-03-02T09:00:00Z"), ZoneOffset.UTC), 10);
    }

    @Test
    public void staysQuietAtOrAboveTheThreshold() {
        assertFalse(alerter.check(HAMMER, 10));
        verify(notifier, never()).send(anyString(), anyString());
    }

    @Test
    public void tellsPurchasingWhenStockRunsLow() {
        assertTrue(alerter.check(HAMMER, 3));
        verify(notifier).send("#purchasing", "HDW-00412 is low: 3 left");
    }

    @Test
    public void saysOutOfStockAtZero() {
        alerter.check(HAMMER, 0);
        verify(notifier).send("#purchasing", "HDW-00412 is OUT OF STOCK: 0 left");
    }

    @Test
    public void alertsOncePerSkuPerDay() {
        alerter.check(HAMMER, 3);
        alerter.check(HAMMER, 2);
        alerter.check(Sku.parse("HDW-00413"), 1);
        verify(notifier, times(2)).send(anyString(), anyString());
    }
}
