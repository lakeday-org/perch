package com.acme.ledger.account;

import com.acme.ledger.journal.Entry;
import com.acme.ledger.journal.Side;
import com.acme.ledger.money.Currency;
import com.acme.ledger.money.Money;

/** One account in the chart, with the running balance of every entry posted to it. */
public class Account {
    private final String code;
    private final String name;
    private final AccountType type;
    private Money balance;
    private boolean frozen;

    public Account(String code, String name, AccountType type, Currency currency) {
        if (code == null || !code.matches("\\d{4}")) {
            throw new IllegalArgumentException("account code must be four digits: " + code);
        }
        this.code = code;
        this.name = name;
        this.type = type;
        this.balance = Money.zero(currency);
    }

    public String code() {
        return code;
    }

    public String name() {
        return name;
    }

    public AccountType type() {
        return type;
    }

    public Money balance() {
        return balance;
    }

    public boolean isFrozen() {
        return frozen;
    }

    public void freeze() {
        frozen = true;
    }

    /** Applies an entry to the balance, which moves up on the account's normal side and down on the other. */
    public void apply(Entry entry) {
        if (frozen) {
            throw new IllegalStateException("account " + code + " is frozen");
        }
        boolean increases = (entry.side() == Side.DEBIT) == type.isDebitNormal();
        balance = increases ? balance.plus(entry.amount()) : balance.minus(entry.amount());
    }
}
