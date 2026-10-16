package com.northwind.warehouse.model;

import java.util.Objects;

/** A bin in the warehouse, written aisle, shelf and bin: {@code A03-S2-B14}. */
public final class Location implements Comparable<Location> {
    /** Walking from one aisle to the next means going round the end of the rack. */
    static final int AISLE_CHANGE_COST = 20;

    private final char aisleRow;
    private final int aisle;
    private final int shelf;
    private final int bin;

    public Location(char aisleRow, int aisle, int shelf, int bin) {
        if (aisle < 1 || shelf < 1 || bin < 1) {
            throw new IllegalArgumentException("aisle, shelf and bin start at 1");
        }
        this.aisleRow = aisleRow;
        this.aisle = aisle;
        this.shelf = shelf;
        this.bin = bin;
    }

    public static Location parse(String text) {
        String[] parts = text.split("-");
        if (parts.length != 3 || parts[0].length() < 2 || parts[1].charAt(0) != 'S' || parts[2].charAt(0) != 'B') {
            throw new IllegalArgumentException("not a location: " + text);
        }
        return new Location(parts[0].charAt(0), Integer.parseInt(parts[0].substring(1)),
                Integer.parseInt(parts[1].substring(1)), Integer.parseInt(parts[2].substring(1)));
    }

    public int aisle() {
        return aisle;
    }

    /** Steps to walk from here to there: along the aisle when it is the same one, round the rack end when it is not. */
    public int distanceTo(Location other) {
        if (aisleRow == other.aisleRow && aisle == other.aisle) {
            return Math.abs(bin - other.bin);
        }
        int aisles = Math.abs(aisle - other.aisle) + (aisleRow == other.aisleRow ? 0 : 10);
        return bin + other.bin + aisles * AISLE_CHANGE_COST;
    }

    @Override
    public int compareTo(Location other) {
        if (aisleRow != other.aisleRow) {
            return Character.compare(aisleRow, other.aisleRow);
        }
        if (aisle != other.aisle) {
            return Integer.compare(aisle, other.aisle);
        }
        return Integer.compare(bin, other.bin);
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof Location
                && ((Location) other).aisleRow == aisleRow
                && ((Location) other).aisle == aisle
                && ((Location) other).shelf == shelf
                && ((Location) other).bin == bin;
    }

    @Override
    public int hashCode() {
        return Objects.hash(aisleRow, aisle, shelf, bin);
    }

    @Override
    public String toString() {
        return String.format("%c%02d-S%d-B%02d", aisleRow, aisle, shelf, bin);
    }
}
