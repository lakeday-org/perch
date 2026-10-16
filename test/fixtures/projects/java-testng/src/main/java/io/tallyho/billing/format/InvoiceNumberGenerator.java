package io.tallyho.billing.format;

import java.time.LocalDate;

/** Numbers invoices PREFIX-YEAR-NNNNN, counting from 1 again each calendar year. */
public class InvoiceNumberGenerator {
    private final String prefix;
    private int year;
    private int sequence;

    public InvoiceNumberGenerator(String prefix, int lastYear, int lastSequence) {
        if (!prefix.matches("[A-Z]{2,5}")) {
            throw new IllegalArgumentException("prefix must be two to five capital letters: " + prefix);
        }
        this.prefix = prefix;
        this.year = lastYear;
        this.sequence = lastSequence;
    }

    public synchronized String next(LocalDate on) {
        if (on.getYear() < year) {
            throw new IllegalArgumentException("cannot number an invoice dated before " + year);
        }
        year = on.getYear();
        sequence++;
        if (sequence > 99_999) {
            throw new IllegalStateException("ran out of invoice numbers for " + year);
        }
        return String.format("%s-%d-%05d", prefix, year, sequence);
    }
}
