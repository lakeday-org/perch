package com.acme.ledger.journal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.acme.ledger.money.Currency;
import com.acme.ledger.money.Money;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;

class JournalEntryTest {
    private static final LocalDate JAN_2 = LocalDate.of(2026, 1, 2);

    @Test
    void needsAtLeastTwoLines() {
        JournalEntry.Builder builder = JournalEntry.on(JAN_2).debit("1000", Money.of("5", Currency.USD));
        assertThrows(IllegalStateException.class, builder::build);
    }


    @Test
    void aReversalSwapsEverySide() {
        JournalEntry entry = JournalEntry.on(JAN_2).memo("Sale")
                .debit("1000", Money.of("5", Currency.USD))
                .credit("4000", Money.of("4", Currency.USD))
                .build();
        JournalEntry reversal = entry.reversal(JAN_2.plusDays(1));
        assertEquals(Side.CREDIT, reversal.entries().get(0).side());
        assertEquals("Reversal of: Sale", reversal.memo());
        assertFalse(reversal.isBalanced());
    }
}
