package io.tallyho.billing.service;

/** What a payment gateway said about a charge. */
public final class ChargeResult {
    private final boolean succeeded;
    private final String reference;
    private final String declineReason;

    private ChargeResult(boolean succeeded, String reference, String declineReason) {
        this.succeeded = succeeded;
        this.reference = reference;
        this.declineReason = declineReason;
    }

    public static ChargeResult success(String reference) {
        return new ChargeResult(true, reference, null);
    }

    public static ChargeResult declined(String reason) {
        return new ChargeResult(false, null, reason);
    }

    public boolean succeeded() {
        return succeeded;
    }

    public String reference() {
        return reference;
    }

    public String declineReason() {
        return declineReason;
    }
}
