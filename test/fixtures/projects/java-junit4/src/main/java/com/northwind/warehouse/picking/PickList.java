package com.northwind.warehouse.picking;

import com.northwind.warehouse.model.Location;
import java.util.List;

/** The lines a picker walks, in the order they walk them, starting from the dispatch bay. */
public class PickList {
    private final Location start;
    private final List<PickLine> lines;

    public PickList(Location start, List<PickLine> lines) {
        this.start = start;
        this.lines = List.copyOf(lines);
    }

    public List<PickLine> lines() {
        return lines;
    }

    public int units() {
        return lines.stream().mapToInt(PickLine::quantity).sum();
    }

    /** Steps walked from the start through every line in order and back again. */
    public int walkingDistance() {
        int distance = 0;
        Location at = start;
        for (PickLine line : lines) {
            distance += at.distanceTo(line.location());
            at = line.location();
        }
        return distance + at.distanceTo(start);
    }
}
