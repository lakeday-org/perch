package com.northwind.warehouse.model;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class LocationTest {

    @Test
    public void parsesAisleShelfAndBin() {
        assertEquals(new Location('A', 3, 2, 14), Location.parse("A03-S2-B14"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsALocationWithoutAShelf() {
        Location.parse("A03-B14");
    }

    @Test
    public void walksAlongTheSameAisle() {
        assertEquals(9, Location.parse("A03-S1-B05").distanceTo(Location.parse("A03-S4-B14")));
    }

    @Test
    public void goesRoundTheRackEndToChangeAisle() {
        assertEquals(5 + 2 + 2 * Location.AISLE_CHANGE_COST, Location.parse("A03-S1-B05").distanceTo(Location.parse("A05-S1-B02")));
    }
}
