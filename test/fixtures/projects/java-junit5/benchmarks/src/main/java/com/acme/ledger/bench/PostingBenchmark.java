package com.acme.ledger.bench;

import com.acme.ledger.account.Account;
import com.acme.ledger.account.AccountType;
import com.acme.ledger.account.InMemoryAccountRepository;
import com.acme.ledger.api.PostingRequest;
import com.acme.ledger.api.PostingService;
import com.acme.ledger.api.RequestValidator;
import com.acme.ledger.journal.Ledger;
import com.acme.ledger.money.Currency;
import java.util.List;

/** Posts a million two-line entries and prints how long it took. Not shipped; run with ./gradlew :benchmarks:run. */
public final class PostingBenchmark {
    private PostingBenchmark() {
    }

    public static void main(String[] args) {
        int rounds = args.length > 0 ? Integer.parseInt(args[0]) : 1_000_000;
        InMemoryAccountRepository accounts = new InMemoryAccountRepository();
        accounts.save(new Account("1000", "Cash", AccountType.ASSET, Currency.USD));
        accounts.save(new Account("4000", "Sales", AccountType.INCOME, Currency.USD));
        PostingService service = new PostingService(new Ledger(accounts, Currency.USD), new RequestValidator(10));
        PostingRequest request = new PostingRequest("2026-01-02", "bench", "USD", List.of(
                new PostingRequest.Line("1000", "debit", "1.00"),
                new PostingRequest.Line("4000", "credit", "1.00")));
        long start = System.nanoTime();
        for (int i = 0; i < rounds; i++) {
            service.submit(request);
        }
        long elapsed = System.nanoTime() - start;
        System.out.printf("%d postings in %.1f ms (%.0f ns each)%n", rounds, elapsed / 1e6, (double) elapsed / rounds);
    }
}
