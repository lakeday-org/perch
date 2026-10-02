package com.acme.ledger.api;

/** The error codes the posting API answers with, and the HTTP status each maps to. */
public enum ApiError {
    INVALID_REQUEST(400),
    UNKNOWN_ACCOUNT(404),
    PERIOD_CLOSED(409),
    UNBALANCED(422);

    private final int status;

    ApiError(int status) {
        this.status = status;
    }

    public int status() {
        return status;
    }

    /** The error a rejection message stands for. */
    public static ApiError classify(String message) {
        if (message.startsWith("no account")) {
            return UNKNOWN_ACCOUNT;
        }
        if (message.contains("is closed")) {
            return PERIOD_CLOSED;
        }
        if (message.startsWith("debits")) {
            return UNBALANCED;
        }
        return INVALID_REQUEST;
    }
}
