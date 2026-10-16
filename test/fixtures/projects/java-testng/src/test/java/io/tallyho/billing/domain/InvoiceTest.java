package io.tallyho.billing.domain;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertThrows;
import static org.testng.Assert.assertTrue;

import io.tallyho.billing.discount.PercentageDiscount;
import io.tallyho.billing.tax.RegionalTaxCalculator;
import java.time.LocalDate;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;

@Test
public class InvoiceTest {
    private static final LocalDate SEP_1 = LocalDate.of(2026, 9, 1);
    private Invoice invoice;

    @BeforeMethod
    public void draft() {
        invoice = new Invoice(Customer.consumer("C-1", "Ada", TaxRegion.US_CA))
                .add(new LineItem("Annual plan", 1, 120_00))
                .add(new LineItem("Extra seats", 3, 15_00));
    }

    public void addsUpItsLines() {
        assertEquals(invoice.subtotal(), 165_00);
    }

    public void takesTheDiscountOffBeforeTax() {
        invoice.discount(new PercentageDiscount(10));
        assertEquals(invoice.discounted(), 148_50);
        assertEquals(invoice.total(new RegionalTaxCalculator(TaxRegion.US_CA)), 148_50 + 10_77);
    }

    public void isDueThirtyDaysAfterIssueByDefault() {
        invoice.issue("TH-2026-00001", SEP_1);
        assertEquals(invoice.dueOn(), LocalDate.of(2026, 10, 1));
    }

    public void becomesOverdueTheDayAfterItIsDue() {
        invoice.terms(14).issue("TH-2026-00001", SEP_1);
        assertFalse(invoice.isOverdue(LocalDate.of(2026, 9, 15)));
        assertTrue(invoice.isOverdue(LocalDate.of(2026, 9, 16)));
    }

    public void cannotBeChangedOnceIssued() {
        invoice.issue("TH-2026-00001", SEP_1);
        assertThrows(IllegalStateException.class, () -> invoice.add(new LineItem("Late addition", 1, 1_00)));
    }

    public void cannotBePaidTwice() {
        invoice.issue("TH-2026-00001", SEP_1);
        invoice.markPaid();
        assertThrows(IllegalStateException.class, invoice::markPaid);
    }

    public void refusesToIssueWithNoLines() {
        Invoice empty = new Invoice(Customer.consumer("C-2", "Grace", TaxRegion.UK));
        assertThrows(IllegalStateException.class, () -> empty.issue("TH-2026-00002", SEP_1));
    }

    @Test(expectedExceptions = IllegalArgumentException.class)
    public void refusesALineWithANegativePrice() {
        new LineItem("Refund", 1, -5_00);
    }
}
