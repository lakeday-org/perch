package com.acme.ledger.report;

import com.acme.ledger.account.Account;
import com.acme.ledger.account.AccountType;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;

/** Formats a chart of accounts as a plain-text statement, grouped by type. */
public class StatementFormatter {
    private final int width;

    public StatementFormatter(int width) {
        if (width < 30) {
            throw new IllegalArgumentException("a statement needs at least 30 columns");
        }
        this.width = width;
    }

    public String format(Collection<Account> accounts) {
        StringBuilder out = new StringBuilder();
        for (AccountType type : AccountType.values()) {
            List<Account> ofType = accounts.stream()
                    .filter(account -> account.type() == type)
                    .sorted(Comparator.comparing(Account::code))
                    .toList();
            if (ofType.isEmpty()) {
                continue;
            }
            out.append(type.name()).append('\n');
            for (Account account : ofType) {
                out.append(line(account.code() + " " + account.name(), account.balance().toString())).append('\n');
            }
        }
        return out.toString();
    }

    private String line(String label, String amount) {
        int gap = Math.max(1, width - label.length() - amount.length());
        return label + " ".repeat(gap) + amount;
    }
}
