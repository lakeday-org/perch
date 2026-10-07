package com.acme.ledger.journal;

import com.acme.ledger.money.Money;

public class UnbalancedEntryException extends RuntimeException {
    private final Money debits;
    private final Money credits;

    public UnbalancedEntryException(Money debits, Money credits) {
        super("debits " + debits + " do not equal credits " + credits);
        this.debits = debits;
        this.credits = credits;
    }

    public Money difference() {
        return debits.minus(credits);
    }
}
