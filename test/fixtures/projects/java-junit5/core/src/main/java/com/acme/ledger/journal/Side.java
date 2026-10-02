package com.acme.ledger.journal;

public enum Side {
    DEBIT,
    CREDIT;

    public Side opposite() {
        return this == DEBIT ? CREDIT : DEBIT;
    }
}
