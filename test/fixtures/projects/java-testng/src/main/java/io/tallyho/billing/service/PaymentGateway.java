package io.tallyho.billing.service;

/** Takes money from a customer's card or account on file. */
public interface PaymentGateway {
    ChargeResult charge(String customerId, long cents, String idempotencyKey);
}
