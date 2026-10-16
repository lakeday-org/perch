package com.acme.ledger.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class RequestValidatorTest {
    private RequestValidator validator;

    @BeforeEach
    void setUp() {
        validator = new RequestValidator(4);
    }

    private static PostingRequest request(String date, PostingRequest.Line... lines) {
        return new PostingRequest(date, "memo", "USD", List.of(lines));
    }

    @Test
    void acceptsAWellFormedRequest() {
        PostingRequest request = request("2026-01-02",
                new PostingRequest.Line("1000", "debit", "10.00"),
                new PostingRequest.Line("4000", "credit", "10.00"));
        assertTrue(validator.validate(request).isEmpty());
    }

    @Test
    void reportsEveryProblemNotJustTheFirst() {
        PostingRequest request = request(null,
                new PostingRequest.Line("1000", "left", "10.00"),
                new PostingRequest.Line("4000", "credit", "-3"));
        assertEquals(List.of("date is required", "line 1: side must be debit or credit", "line 2: amount must be a positive decimal"),
                validator.validate(request));
    }

    @ParameterizedTest
    @ValueSource(strings = {"2026-13-01", "01/02/2026", "yesterday"})
    void rejectsADateThatIsNotIso(String date) {
        PostingRequest request = request(date,
                new PostingRequest.Line("1000", "debit", "1"),
                new PostingRequest.Line("4000", "credit", "1"));
        assertEquals(List.of("date is not ISO-8601: " + date), validator.validate(request));
    }
}
