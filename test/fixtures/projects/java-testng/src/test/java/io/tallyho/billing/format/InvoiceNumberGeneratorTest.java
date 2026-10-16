package io.tallyho.billing.format;

import static org.testng.Assert.assertEquals;

import java.time.LocalDate;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;

@Test
public class InvoiceNumberGeneratorTest {
    private InvoiceNumberGenerator numbers;

    @BeforeMethod
    public void continueFromLastYear() {
        numbers = new InvoiceNumberGenerator("TH", 2025, 412);
    }

    public void countsOnFromTheLastNumberIssued() {
        assertEquals(numbers.next(LocalDate.of(2025, 12, 30)), "TH-2025-00413");
        assertEquals(numbers.next(LocalDate.of(2025, 12, 31)), "TH-2025-00414");
    }

    public void restartsTheSequenceInANewYear() {
        assertEquals(numbers.next(LocalDate.of(2026, 1, 2)), "TH-2026-00001");
    }

    @Test(expectedExceptions = IllegalArgumentException.class)
    public void refusesToNumberAnInvoiceBackdatedIntoAClosedYear() {
        numbers.next(LocalDate.of(2024, 6, 1));
    }

    @Test(expectedExceptions = IllegalArgumentException.class)
    public void refusesALowercasePrefix() {
        new InvoiceNumberGenerator("th", 2025, 0);
    }
}
