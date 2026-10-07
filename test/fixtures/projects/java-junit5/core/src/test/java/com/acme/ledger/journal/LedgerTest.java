package com.acme.ledger.journal;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.acme.ledger.account.Account;
import com.acme.ledger.account.AccountType;
import com.acme.ledger.account.InMemoryAccountRepository;
import com.acme.ledger.money.Currency;
import com.acme.ledger.money.Money;
import java.time.LocalDate;
import java.util.NoSuchElementException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

class LedgerTest {
    private static final LocalDate JAN_2 = LocalDate.of(2026, 1, 2);
    private Ledger ledger;

    @BeforeEach
    void openBooks() {
        InMemoryAccountRepository accounts = new InMemoryAccountRepository();
        accounts.save(new Account("1000", "Cash", AccountType.ASSET, Currency.USD));
        accounts.save(new Account("2100", "Sales tax payable", AccountType.LIABILITY, Currency.USD));
        accounts.save(new Account("4000", "Sales", AccountType.INCOME, Currency.USD));
        ledger = new Ledger(accounts, Currency.USD);
    }

    private static JournalEntry sale(LocalDate on, String net, String tax, String gross) {
        return JournalEntry.on(on).memo("Counter sale")
                .debit("1000", usd(gross))
                .credit("4000", usd(net))
                .credit("2100", usd(tax))
                .build();
    }

    private static Money usd(String amount) {
        return Money.of(amount, Currency.USD);
    }

    @Test
    void postsABalancedEntryToEveryAccountItNames() {
        ledger.post(sale(JAN_2, "100.00", "8.25", "108.25"));
        assertEquals(usd("108.25"), ledger.balanceOf("1000"));
        assertEquals(usd("100.00"), ledger.balanceOf("4000"));
        assertEquals(usd("8.25"), ledger.balanceOf("2100"));
    }

    @Test
    void refusesAnUnbalancedEntryAndSaysByHowMuch() {
        UnbalancedEntryException thrown = assertThrows(UnbalancedEntryException.class,
                () -> ledger.post(sale(JAN_2, "100.00", "8.25", "110.00")));
        assertEquals(usd("1.75"), thrown.difference());
        assertTrue(ledger.journal().isEmpty());
    }

    @Test
    void refusesAnEntryToAnAccountNotInTheChart() {
        JournalEntry entry = JournalEntry.on(JAN_2).debit("1000", usd("5")).credit("9999", usd("5")).build();
        assertThrows(NoSuchElementException.class, () -> ledger.post(entry));
        assertEquals(Money.zero(Currency.USD), ledger.balanceOf("1000"));
    }

    @Test
    void theTrialBalanceIsZeroAfterBalancedPostings() {
        ledger.post(sale(JAN_2, "100.00", "8.25", "108.25"));
        ledger.post(sale(JAN_2.plusDays(1), "20.00", "1.65", "21.65"));
        assertTrue(ledger.trialBalance().isZero());
    }

    @Test
    @Disabled("multi-currency books are not supported yet")
    void postsAnEntryInASecondCurrency() {
        JournalEntry entry = JournalEntry.on(JAN_2)
                .debit("1000", Money.of("5", Currency.EUR))
                .credit("4000", Money.of("5", Currency.EUR))
                .build();
        assertDoesNotThrow(() -> ledger.post(entry));
    }

    @Nested
    class AfterAPeriodIsClosed {

        @BeforeEach
        void closeDecember() {
            ledger.closeThrough(LocalDate.of(2025, 12, 31));
        }

        @Test
        void refusesAnEntryDatedInsideIt() {
            assertThrows(IllegalStateException.class, () -> ledger.post(sale(LocalDate.of(2025, 12, 31), "0.90", "0.10", "1.00")));
        }

        @Test
        void acceptsAnEntryDatedAfterIt() {
            ledger.post(sale(JAN_2, "1.00", "0.10", "1.10"));
            assertEquals(1, ledger.journal().size());
        }

        @Test
        void cannotBeReopened() {
            assertThrows(IllegalArgumentException.class, () -> ledger.closeThrough(LocalDate.of(2025, 11, 30)));
        }
    }
}
