package io.tallyho.billing.discount;

/** Something taken off a subtotal before tax. */
public interface Discount {
    long apply(long subtotalCents);

    String describe();
}
