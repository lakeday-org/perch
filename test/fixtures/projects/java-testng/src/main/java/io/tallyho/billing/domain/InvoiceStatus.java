package io.tallyho.billing.domain;

import java.util.EnumSet;
import java.util.Set;

/** Where an invoice is in its life, and where it may go from there. */
public enum InvoiceStatus {
    DRAFT,
    ISSUED,
    PAID,
    VOID;

    public Set<InvoiceStatus> next() {
        switch (this) {
            case DRAFT:
                return EnumSet.of(ISSUED, VOID);
            case ISSUED:
                return EnumSet.of(PAID, VOID);
            default:
                return EnumSet.noneOf(InvoiceStatus.class);
        }
    }

    public boolean canMoveTo(InvoiceStatus target) {
        return next().contains(target);
    }

    public boolean isFinal() {
        return next().isEmpty();
    }
}
