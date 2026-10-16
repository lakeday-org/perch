package io.tallyho.billing.domain;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertTrue;

import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;

public class InvoiceStatusTest {

    @DataProvider(name = "moves")
    public Object[][] moves() {
        return new Object[][] {
            {InvoiceStatus.DRAFT, InvoiceStatus.ISSUED, true},
            {InvoiceStatus.DRAFT, InvoiceStatus.PAID, false},
            {InvoiceStatus.ISSUED, InvoiceStatus.PAID, true},
            {InvoiceStatus.ISSUED, InvoiceStatus.DRAFT, false},
            {InvoiceStatus.PAID, InvoiceStatus.VOID, false},
            {InvoiceStatus.VOID, InvoiceStatus.ISSUED, false},
        };
    }

    @Test(dataProvider = "moves")
    public void allowsOnlyForwardMoves(InvoiceStatus from, InvoiceStatus to, boolean allowed) {
        assertEquals(from.canMoveTo(to), allowed);
    }

    @Test
    public void paidAndVoidAreFinal() {
        assertTrue(InvoiceStatus.PAID.isFinal());
        assertTrue(InvoiceStatus.VOID.isFinal());
    }
}
