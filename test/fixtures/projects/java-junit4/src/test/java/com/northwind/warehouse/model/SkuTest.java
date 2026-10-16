package com.northwind.warehouse.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SkuTest {

    @Test
    public void parsesCategoryAndNumber() {
        Sku sku = Sku.parse(" HDW-00412 ");
        assertEquals("HDW", sku.category());
        assertEquals(412, sku.number());
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsALowercaseCategory() {
        Sku.parse("hdw-00412");
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsAShortNumber() {
        Sku.parse("HDW-412");
    }

    @Test
    public void printsTheNumberZeroPadded() {
        assertEquals("ELC-00007", Sku.parse("ELC-00007").toString());
    }

    @Test
    public void sortsByCategoryThenNumber() {
        assertTrue(Sku.parse("ELC-99999").compareTo(Sku.parse("HDW-00001")) < 0);
        assertTrue(Sku.parse("HDW-00002").compareTo(Sku.parse("HDW-00010")) < 0);
    }
}
