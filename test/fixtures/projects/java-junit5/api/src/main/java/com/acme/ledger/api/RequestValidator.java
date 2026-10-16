package com.acme.ledger.api;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Checks a request's shape before anything is parsed into money. Every problem is reported, not just the first. */
public class RequestValidator {
    private static final Set<String> SIDES = Set.of("debit", "credit");
    private final int maxLines;

    public RequestValidator(int maxLines) {
        this.maxLines = maxLines;
    }

    public List<String> validate(PostingRequest request) {
        List<String> errors = new ArrayList<>();
        if (request.date() == null) {
            errors.add("date is required");
        } else {
            try {
                LocalDate.parse(request.date());
            } catch (DateTimeParseException e) {
                errors.add("date is not ISO-8601: " + request.date());
            }
        }
        if (request.lines() == null || request.lines().size() < 2) {
            errors.add("a posting needs at least two lines");
            return errors;
        }
        if (request.lines().size() > maxLines) {
            errors.add("a posting may have at most " + maxLines + " lines");
        }
        for (int i = 0; i < request.lines().size(); i++) {
            PostingRequest.Line line = request.lines().get(i);
            if (!SIDES.contains(line.side())) {
                errors.add("line " + (i + 1) + ": side must be debit or credit");
            }
            if (line.amount() == null || !line.amount().matches("\\d+(\\.\\d+)?")) {
                errors.add("line " + (i + 1) + ": amount must be a positive decimal");
            }
        }
        return errors;
    }
}
