package com.northwind.warehouse.picking;

import com.northwind.warehouse.model.Location;
import java.util.Comparator;

/** How a planner orders the lines of a pick list. */
public enum PickStrategy {
    /** Walk the warehouse in location order, aisle by aisle. */
    LOCATION_ORDER,
    /** Always go to the closest remaining line next. */
    NEAREST_NEXT,
    /** Biggest picks first, so the heavy items sit at the bottom of the trolley. */
    HEAVIEST_FIRST;

    public Comparator<PickLine> comparator() {
        switch (this) {
            case HEAVIEST_FIRST:
                return Comparator.comparingInt(PickLine::quantity).reversed().thenComparing(PickLine::location);
            case LOCATION_ORDER:
            default:
                return Comparator.comparing(PickLine::location);
        }
    }

    public boolean isGreedy() {
        return this == NEAREST_NEXT;
    }

    public static PickStrategy forUnits(int units) {
        if (units > 200) {
            return HEAVIEST_FIRST;
        }
        return units > 20 ? NEAREST_NEXT : LOCATION_ORDER;
    }
}
