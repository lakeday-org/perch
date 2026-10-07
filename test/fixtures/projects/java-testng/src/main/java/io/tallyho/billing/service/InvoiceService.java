package io.tallyho.billing.service;

import io.tallyho.billing.domain.Invoice;
import io.tallyho.billing.domain.InvoiceStatus;
import io.tallyho.billing.format.InvoiceNumberGenerator;
import io.tallyho.billing.tax.TaxCalculator;
import java.time.Clock;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/** Issues invoices, collects them through the payment gateway, and finds the ones that are overdue. */
public class InvoiceService {
    private final InvoiceRepository repository;
    private final PaymentGateway gateway;
    private final TaxCalculator tax;
    private final InvoiceNumberGenerator numbers;
    private final Clock clock;

    public InvoiceService(InvoiceRepository repository, PaymentGateway gateway, TaxCalculator tax, InvoiceNumberGenerator numbers, Clock clock) {
        this.repository = repository;
        this.gateway = gateway;
        this.tax = tax;
        this.numbers = numbers;
        this.clock = clock;
    }

    public String issue(Invoice invoice) {
        LocalDate today = LocalDate.now(clock);
        invoice.issue(numbers.next(today), today);
        repository.save(invoice);
        return invoice.number();
    }

    /** Charges the invoice's total. A decline leaves the invoice issued and says why; it is not an exception. */
    public ChargeResult collect(Invoice invoice) {
        if (invoice.status() != InvoiceStatus.ISSUED) {
            throw new IllegalStateException("only an issued invoice can be collected, not a " + invoice.status() + " one");
        }
        ChargeResult result = gateway.charge(invoice.customer().id(), invoice.total(tax), invoice.number());
        if (result.succeeded()) {
            invoice.markPaid();
            repository.save(invoice);
        }
        return result;
    }

    public List<Invoice> overdue() {
        LocalDate today = LocalDate.now(clock);
        List<Invoice> late = new ArrayList<>();
        for (Invoice invoice : repository.issued()) {
            if (invoice.isOverdue(today)) {
                late.add(invoice);
            }
        }
        return late;
    }
}
