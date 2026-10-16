package com.acme.ledger.api;

import java.util.List;

/** What a posting came to: accepted with the journal's size after it, or rejected with the reasons. */
public record PostingResult(boolean accepted, int journalSize, List<String> errors) {

    public static PostingResult accepted(int journalSize) {
        return new PostingResult(true, journalSize, List.of());
    }

    public static PostingResult rejected(List<String> errors) {
        return new PostingResult(false, -1, List.copyOf(errors));
    }
}
