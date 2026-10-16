package com.acme.ledger.journal;

import com.acme.ledger.money.Money;

/** One line of a journal entry: an amount on one side of one account. */
public record Entry(String account, Side side, Money amount) {

    public Entry {
        if (amount.isNegative() || amount.isZero()) {
            throw new IllegalArgumentException("an entry's amount must be positive, was " + amount);
        }
    }

    public static Entry debit(String account, Money amount) {
        return new Entry(account, Side.DEBIT, amount);
    }

    public static Entry credit(String account, Money amount) {
        return new Entry(account, Side.CREDIT, amount);
    }

    public Entry reversed() {
        return new Entry(account, side.opposite(), amount);
    }
}
