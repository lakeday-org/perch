package com.acme.ledger.api;

import java.util.List;

/** A posting as a client sends it: amounts as decimal strings, sides as words. */
public record PostingRequest(String date, String memo, String currency, List<Line> lines) {

    public record Line(String account, String side, String amount) {
    }
}
