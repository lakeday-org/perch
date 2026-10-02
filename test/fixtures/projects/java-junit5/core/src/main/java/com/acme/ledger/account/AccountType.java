package com.acme.ledger.account;

/** The five kinds of account, and which side of an entry increases each. */
public enum AccountType {
    ASSET,
    LIABILITY,
    EQUITY,
    INCOME,
    EXPENSE;

    /** Assets and expenses grow with a debit; the rest grow with a credit. */
    public boolean isDebitNormal() {
        return this == ASSET || this == EXPENSE;
    }

    /** Whether the account is closed into retained earnings at the end of a period. */
    public boolean isTemporary() {
        switch (this) {
            case INCOME:
            case EXPENSE:
                return true;
            default:
                return false;
        }
    }
}
