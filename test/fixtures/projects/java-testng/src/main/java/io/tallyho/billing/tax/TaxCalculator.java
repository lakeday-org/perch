package io.tallyho.billing.tax;

import io.tallyho.billing.domain.Customer;

/** The tax on a net amount for a customer, in cents. */
public interface TaxCalculator {
    long taxOn(long netCents, Customer customer);
}
