package com.acme.ledger.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.acme.ledger.journal.JournalEntry;
import com.acme.ledger.journal.Ledger;
import com.acme.ledger.journal.Side;
import com.acme.ledger.journal.UnbalancedEntryException;
import com.acme.ledger.money.Currency;
import com.acme.ledger.money.Money;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class PostingServiceTest {
    private Ledger ledger;
    private PostingService service;

    private static final PostingRequest SALE = new PostingRequest("2026-01-02", "Sale", "USD", List.of(
            new PostingRequest.Line("1000", "debit", "10.00"),
            new PostingRequest.Line("4000", "credit", "10.00")));

    @BeforeEach
    void setUp() {
        ledger = mock(Ledger.class);
        service = new PostingService(ledger, new RequestValidator(10));
    }

    @Test
    void postsAValidRequestToTheLedger() {
        when(ledger.journal()).thenReturn(List.of());
        PostingResult result = service.submit(SALE);
        assertTrue(result.accepted());
        verify(ledger).post(any(JournalEntry.class));
    }

    @Test
    void rejectsAnInvalidRequestWithoutTouchingTheLedger() {
        PostingRequest bad = new PostingRequest("2026-01-02", "Sale", "USD", List.of());
        PostingResult result = service.submit(bad);
        assertFalse(result.accepted());
        verifyNoInteractions(ledger);
    }

    @Test
    void turnsALedgerRefusalIntoARejection() {
        doThrow(new UnbalancedEntryException(Money.of("10", Currency.USD), Money.of("9", Currency.USD))).when(ledger).post(any());
        PostingResult result = service.submit(SALE);
        assertEquals(List.of("debits $10.00 do not equal credits $9.00"), result.errors());
    }

    @Test
    void buildsAJournalEntryFromTheRequest() {
        JournalEntry entry = PostingService.toEntry(SALE);
        assertEquals(Money.of("10.00", Currency.USD), entry.total(Side.DEBIT));
        assertEquals("Sale", entry.memo());
    }

    @ParameterizedTest
    @CsvSource({
        "'no account 9999', UNKNOWN_ACCOUNT",
        "'period through 2025-12-31 is closed', PERIOD_CLOSED",
        "'debits $1.00 do not equal credits $2.00', UNBALANCED",
        "'line 1: side must be debit or credit', INVALID_REQUEST",
    })
    void classifiesARejectionMessage(String message, ApiError expected) {
        assertEquals(expected, ApiError.classify(message));
    }
}
