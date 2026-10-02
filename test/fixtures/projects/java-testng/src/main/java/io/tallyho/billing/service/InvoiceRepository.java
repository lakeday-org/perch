package io.tallyho.billing.service;

import io.tallyho.billing.domain.Invoice;
import java.util.List;

public interface InvoiceRepository {
    void save(Invoice invoice);

    List<Invoice> issued();
}
