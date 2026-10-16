package com.northwind.warehouse.model;

import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A stock-keeping unit, written as a three-letter category and a five-digit number: {@code HDW-00412}. */
public final class Sku implements Comparable<Sku> {
    private static final Pattern FORMAT = Pattern.compile("([A-Z]{3})-(\\d{5})");

    private final String category;
    private final int number;

    private Sku(String category, int number) {
        this.category = category;
        this.number = number;
    }

    public static Sku parse(String text) {
        Matcher matcher = FORMAT.matcher(text == null ? "" : text.trim());
        if (!matcher.matches()) {
            throw new IllegalArgumentException("not a SKU: " + text);
        }
        return new Sku(matcher.group(1), Integer.parseInt(matcher.group(2)));
    }

    public String category() {
        return category;
    }

    public int number() {
        return number;
    }

    @Override
    public int compareTo(Sku other) {
        int byCategory = category.compareTo(other.category);
        return byCategory != 0 ? byCategory : Integer.compare(number, other.number);
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof Sku)) {
            return false;
        }
        Sku sku = (Sku) other;
        return number == sku.number && category.equals(sku.category);
    }

    @Override
    public int hashCode() {
        return Objects.hash(category, number);
    }

    @Override
    public String toString() {
        return String.format("%s-%05d", category, number);
    }
}
