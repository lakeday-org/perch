package com.acme.ledger.account;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.acme.ledger.journal.Entry;
import com.acme.ledger.money.Currency;
import com.acme.ledger.money.Money;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

class AccountTest {
    private Account cash;
    private Account sales;

    @BeforeEach
    void openAccounts() {
        cash = new Account("1000", "Cash", AccountType.ASSET, Currency.USD);
        sales = new Account("4000", "Sales", AccountType.INCOME, Currency.USD);
    }

    @Test
    void aDebitRaisesAnAsset() {
        cash.apply(Entry.debit("1000", Money.of("25.00", Currency.USD)));
        assertEquals(Money.of("25.00", Currency.USD), cash.balance());
    }

    @Test
    void aCreditLowersAnAsset() {
        cash.apply(Entry.debit("1000", Money.of("25.00", Currency.USD)));
        cash.apply(Entry.credit("1000", Money.of("10.00", Currency.USD)));
        assertEquals(Money.of("15.00", Currency.USD), cash.balance());
    }


    @Test
    void aFrozenAccountRefusesEntries() {
        cash.freeze();
        assertThrows(IllegalStateException.class, () -> cash.apply(Entry.debit("1000", Money.of("1", Currency.USD))));
    }

    @ParameterizedTest
    @ValueSource(strings = {"100", "10000", "1a00", ""})
    void rejectsACodeThatIsNotFourDigits(String code) {
        assertThrows(IllegalArgumentException.class, () -> new Account(code, "Bad", AccountType.ASSET, Currency.USD));
    }

    @ParameterizedTest
    @CsvSource({"ASSET, false", "LIABILITY, false", "EQUITY, false", "INCOME, true", "EXPENSE, true"})
    void closesOnlyIncomeAndExpenseAtPeriodEnd(AccountType type, boolean temporary) {
        assertEquals(temporary, type.isTemporary());
    }
}
