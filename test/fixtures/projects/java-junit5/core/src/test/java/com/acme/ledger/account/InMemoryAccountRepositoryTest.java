package com.acme.ledger.account;

import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.acme.ledger.money.Currency;
import org.junit.jupiter.api.Test;

class InMemoryAccountRepositoryTest {
    private final InMemoryAccountRepository repository = new InMemoryAccountRepository();

    @Test
    void findsASavedAccountByCode() {
        Account cash = new Account("1000", "Cash", AccountType.ASSET, Currency.USD);
        repository.save(cash);
        assertSame(cash, repository.find("1000").orElseThrow());
        assertTrue(repository.find("2000").isEmpty());
    }

    @Test
    void refusesASecondAccountWithTheSameCode() {
        repository.save(new Account("1000", "Cash", AccountType.ASSET, Currency.USD));
        Account clash = new Account("1000", "Petty cash", AccountType.ASSET, Currency.USD);
        assertThrows(IllegalStateException.class, () -> repository.save(clash));
    }
}
