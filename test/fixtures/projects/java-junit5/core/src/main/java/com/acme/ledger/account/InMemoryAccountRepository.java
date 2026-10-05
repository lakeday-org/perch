package com.acme.ledger.account;

import java.util.Collection;
import java.util.Collections;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

/** Accounts kept in a sorted map, by code. */
public class InMemoryAccountRepository implements AccountRepository {
    private final Map<String, Account> accounts = new TreeMap<>();

    @Override
    public Optional<Account> find(String code) {
        return Optional.ofNullable(accounts.get(code));
    }

    @Override
    public void save(Account account) {
        if (accounts.containsKey(account.code()) && accounts.get(account.code()) != account) {
            throw new IllegalStateException("account " + account.code() + " already exists");
        }
        accounts.put(account.code(), account);
    }

    @Override
    public Collection<Account> all() {
        return Collections.unmodifiableCollection(accounts.values());
    }
}
