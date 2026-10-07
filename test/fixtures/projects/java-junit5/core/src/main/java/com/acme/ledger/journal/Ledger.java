package com.acme.ledger.journal;

import com.acme.ledger.account.Account;
import com.acme.ledger.account.AccountRepository;
import com.acme.ledger.money.Currency;
import com.acme.ledger.money.Money;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.NoSuchElementException;

/** Posts balanced journal entries to accounts, refusing anything dated inside a closed period. */
public class Ledger {
    private final AccountRepository accounts;
    private final Currency currency;
    private final List<JournalEntry> journal = new ArrayList<>();
    private LocalDate closedThrough;

    public Ledger(AccountRepository accounts, Currency currency) {
        this.accounts = accounts;
        this.currency = currency;
    }

    public void post(JournalEntry entry) {
        if (!entry.isBalanced()) {
            throw new UnbalancedEntryException(entry.total(Side.DEBIT), entry.total(Side.CREDIT));
        }
        if (closedThrough != null && !entry.date().isAfter(closedThrough)) {
            throw new IllegalStateException("period through " + closedThrough + " is closed");
        }
        List<Account> touched = new ArrayList<>();
        for (Entry line : entry.entries()) {
            if (line.amount().currency() != currency) {
                throw new IllegalArgumentException("ledger books in " + currency + ", entry is in " + line.amount().currency());
            }
            touched.add(account(line.account()));
        }
        for (int i = 0; i < touched.size(); i++) {
            touched.get(i).apply(entry.entries().get(i));
        }
        journal.add(entry);
    }

    public Money balanceOf(String code) {
        return account(code).balance();
    }

    /** The sum of every debit-normal balance less every credit-normal one, which is zero when the books balance. */
    public Money trialBalance() {
        Money total = Money.zero(currency);
        for (Account account : accounts.all()) {
            total = account.type().isDebitNormal() ? total.plus(account.balance()) : total.minus(account.balance());
        }
        return total;
    }

    public void closeThrough(LocalDate date) {
        if (closedThrough != null && date.isBefore(closedThrough)) {
            throw new IllegalArgumentException("cannot reopen a closed period");
        }
        closedThrough = date;
    }

    public List<JournalEntry> journal() {
        return Collections.unmodifiableList(journal);
    }

    private Account account(String code) {
        return accounts.find(code).orElseThrow(() -> new NoSuchElementException("no account " + code));
    }
}
