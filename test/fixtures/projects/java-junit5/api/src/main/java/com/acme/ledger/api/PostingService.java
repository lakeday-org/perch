package com.acme.ledger.api;

import com.acme.ledger.journal.Entry;
import com.acme.ledger.journal.JournalEntry;
import com.acme.ledger.journal.Ledger;
import com.acme.ledger.journal.UnbalancedEntryException;
import com.acme.ledger.money.Currency;
import com.acme.ledger.money.Money;
import java.time.LocalDate;
import java.util.List;
import java.util.NoSuchElementException;

/** Turns client requests into journal entries and posts them, answering with a result rather than an exception. */
public class PostingService {
    private final Ledger ledger;
    private final RequestValidator validator;

    public PostingService(Ledger ledger, RequestValidator validator) {
        this.ledger = ledger;
        this.validator = validator;
    }

    public PostingResult submit(PostingRequest request) {
        List<String> errors = validator.validate(request);
        if (!errors.isEmpty()) {
            return PostingResult.rejected(errors);
        }
        try {
            ledger.post(toEntry(request));
        } catch (UnbalancedEntryException | NoSuchElementException | IllegalStateException e) {
            return PostingResult.rejected(List.of(e.getMessage()));
        }
        return PostingResult.accepted(ledger.journal().size());
    }

    static JournalEntry toEntry(PostingRequest request) {
        Currency currency = Currency.fromCode(request.currency());
        JournalEntry.Builder builder = JournalEntry.on(LocalDate.parse(request.date())).memo(request.memo());
        for (PostingRequest.Line line : request.lines()) {
            Money amount = Money.of(line.amount(), currency);
            builder.add("debit".equals(line.side()) ? Entry.debit(line.account(), amount) : Entry.credit(line.account(), amount));
        }
        return builder.build();
    }
}
