package io.tallyho.billing.service;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;

import io.tallyho.billing.domain.Customer;
import io.tallyho.billing.domain.Invoice;
import io.tallyho.billing.domain.InvoiceStatus;
import io.tallyho.billing.domain.LineItem;
import io.tallyho.billing.domain.TaxRegion;
import io.tallyho.billing.format.InvoiceNumberGenerator;
import io.tallyho.billing.tax.RegionalTaxCalculator;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;

public class InvoiceServiceTest {
    private static final Clock OCT_15 = Clock.fixed(Instant.parse("2026-10-15T12:00:00Z"), ZoneOffset.UTC);

    private InvoiceRepository repository;
    private PaymentGateway gateway;
    private InvoiceService service;

    @BeforeMethod
    public void setUp() {
        repository = mock(InvoiceRepository.class);
        gateway = mock(PaymentGateway.class);
        service = new InvoiceService(repository, gateway, new RegionalTaxCalculator(TaxRegion.US_OR),
                new InvoiceNumberGenerator("TH", 2026, 0), OCT_15);
    }

    private static Invoice draft() {
        return new Invoice(Customer.consumer("C-9", "Linus", TaxRegion.US_OR)).add(new LineItem("Support", 2, 50_00));
    }

    @Test
    public void numbersAndSavesAnIssuedInvoice() {
        Invoice invoice = draft();
        assertEquals(service.issue(invoice), "TH-2026-00001");
        verify(repository).save(invoice);
    }

    @Test
    public void marksAnInvoicePaidWhenTheChargeGoesThrough() {
        Invoice invoice = draft();
        service.issue(invoice);
        when(gateway.charge("C-9", 100_00, "TH-2026-00001")).thenReturn(ChargeResult.success("ch_1"));
        service.collect(invoice);
        assertEquals(invoice.status(), InvoiceStatus.PAID);
    }

    @Test
    public void leavesAnInvoiceIssuedWhenTheChargeIsDeclined() {
        Invoice invoice = draft();
        service.issue(invoice);
        when(gateway.charge(anyString(), anyLong(), anyString())).thenReturn(ChargeResult.declined("insufficient_funds"));
        ChargeResult result = service.collect(invoice);
        assertFalse(result.succeeded());
        assertEquals(invoice.status(), InvoiceStatus.ISSUED);
    }

    @Test(expectedExceptions = IllegalStateException.class)
    public void refusesToCollectADraft() {
        service.collect(draft());
        verify(gateway, never()).charge(anyString(), anyLong(), eq(null));
    }

    @Test
    public void findsTheInvoicesPastTheirDueDate() {
        Invoice late = draft();
        late.issue("TH-2026-00007", OCT_15.instant().atZone(ZoneOffset.UTC).toLocalDate().minusDays(31));
        Invoice current = draft();
        current.issue("TH-2026-00008", OCT_15.instant().atZone(ZoneOffset.UTC).toLocalDate().minusDays(5));
        when(repository.issued()).thenReturn(List.of(late, current));
        assertEquals(service.overdue(), List.of(late));
    }

    @Test(enabled = false, description = "retries are not built yet")
    public void retriesADeclineOnceAfterAnHour() {
        Invoice invoice = draft();
        service.issue(invoice);
        when(gateway.charge(anyString(), anyLong(), anyString()))
                .thenReturn(ChargeResult.declined("try_again_later"), ChargeResult.success("ch_2"));
        service.collect(invoice);
        assertEquals(invoice.status(), InvoiceStatus.PAID);
    }
}
