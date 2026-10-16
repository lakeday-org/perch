package com.acme.ledger.journal;

import com.acme.ledger.money.Currency;
import com.acme.ledger.money.Money;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/** A dated set of entries that must balance: the debits and the credits add up to the same amount. */
public final class JournalEntry {
    private final LocalDate date;
    private final String memo;
    private final List<Entry> entries;

    private JournalEntry(LocalDate date, String memo, List<Entry> entries) {
        this.date = date;
        this.memo = memo;
        this.entries = List.copyOf(entries);
    }

    public static Builder on(LocalDate date) {
        return new Builder(date);
    }

    public LocalDate date() {
        return date;
    }

    public String memo() {
        return memo;
    }

    public List<Entry> entries() {
        return entries;
    }

    public Money total(Side side) {
        Currency currency = entries.get(0).amount().currency();
        Money sum = Money.zero(currency);
        for (Entry entry : entries) {
            if (entry.side() == side) {
                sum = sum.plus(entry.amount());
            }
        }
        return sum;
    }

    public boolean isBalanced() {
        return total(Side.DEBIT).equals(total(Side.CREDIT));
    }

    /** The entry that undoes this one, dated the given day. */
    public JournalEntry reversal(LocalDate on) {
        Builder builder = new Builder(on).memo("Reversal of: " + memo);
        for (Entry entry : entries) {
            builder.add(entry.reversed());
        }
        return builder.build();
    }

    public static final class Builder {
        private final LocalDate date;
        private final List<Entry> entries = new ArrayList<>();
        private String memo = "";

        private Builder(LocalDate date) {
            this.date = date;
        }

        public Builder memo(String memo) {
            this.memo = memo;
            return this;
        }

        public Builder add(Entry entry) {
            entries.add(entry);
            return this;
        }

        public Builder debit(String account, Money amount) {
            return add(Entry.debit(account, amount));
        }

        public Builder credit(String account, Money amount) {
            return add(Entry.credit(account, amount));
        }

        public JournalEntry build() {
            if (entries.size() < 2) {
                throw new IllegalStateException("a journal entry needs at least two lines");
            }
            return new JournalEntry(date, memo, entries);
        }
    }
}
