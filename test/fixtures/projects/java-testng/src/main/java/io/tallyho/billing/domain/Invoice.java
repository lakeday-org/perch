package io.tallyho.billing.domain;

import io.tallyho.billing.discount.Discount;
import io.tallyho.billing.tax.TaxCalculator;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** An invoice: lines, at most one discount, tax on what is left, and the status it is in. */
public class Invoice {
    private final Customer customer;
    private final List<LineItem> lines = new ArrayList<>();
    private Discount discount;
    private InvoiceStatus status = InvoiceStatus.DRAFT;
    private String number;
    private LocalDate issuedOn;
    private int termsDays = 30;

    public Invoice(Customer customer) {
        this.customer = customer;
    }

    public Customer customer() {
        return customer;
    }

    public Invoice add(LineItem line) {
        requireDraft();
        lines.add(line);
        return this;
    }

    public Invoice discount(Discount discount) {
        requireDraft();
        this.discount = discount;
        return this;
    }

    public Invoice terms(int days) {
        this.termsDays = days;
        return this;
    }

    public List<LineItem> lines() {
        return Collections.unmodifiableList(lines);
    }

    public long subtotal() {
        long sum = 0;
        for (LineItem line : lines) {
            sum += line.subtotal();
        }
        return sum;
    }

    public long discounted() {
        long subtotal = subtotal();
        return discount == null ? subtotal : discount.apply(subtotal);
    }

    public long total(TaxCalculator tax) {
        long net = discounted();
        return net + tax.taxOn(net, customer);
    }

    public void issue(String number, LocalDate on) {
        move(InvoiceStatus.ISSUED);
        if (lines.isEmpty()) {
            throw new IllegalStateException("cannot issue an empty invoice");
        }
        this.number = number;
        this.issuedOn = on;
    }

    public void markPaid() {
        move(InvoiceStatus.PAID);
    }

    public void voidIt() {
        move(InvoiceStatus.VOID);
    }

    public InvoiceStatus status() {
        return status;
    }

    public String number() {
        return number;
    }

    public LocalDate dueOn() {
        if (issuedOn == null) {
            throw new IllegalStateException("a draft has no due date");
        }
        return issuedOn.plusDays(termsDays);
    }

    public boolean isOverdue(LocalDate today) {
        return status == InvoiceStatus.ISSUED && today.isAfter(dueOn());
    }

    private void move(InvoiceStatus target) {
        if (!status.canMoveTo(target)) {
            throw new IllegalStateException("cannot go from " + status + " to " + target);
        }
        status = target;
    }

    private void requireDraft() {
        if (status != InvoiceStatus.DRAFT) {
            throw new IllegalStateException("invoice " + number + " is " + status + " and cannot be changed");
        }
    }
}
