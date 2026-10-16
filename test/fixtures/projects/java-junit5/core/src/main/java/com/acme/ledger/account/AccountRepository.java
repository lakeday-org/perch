package com.acme.ledger.account;

import java.util.Collection;
import java.util.Optional;

/** Where accounts are kept. */
public interface AccountRepository {
    Optional<Account> find(String code);

    void save(Account account);

    Collection<Account> all();
}
