package io.tallyho.billing.domain;

/** Who an invoice is addressed to. A business in the EU with a VAT number is charged VAT by reverse charge. */
public class Customer {
    private final String id;
    private final String name;
    private final TaxRegion region;
    private final String vatNumber;
    private boolean taxExempt;

    public Customer(String id, String name, TaxRegion region, String vatNumber) {
        this.id = id;
        this.name = name;
        this.region = region;
        this.vatNumber = vatNumber;
    }

    public static Customer consumer(String id, String name, TaxRegion region) {
        return new Customer(id, name, region, null);
    }

    public String id() {
        return id;
    }

    public String name() {
        return name;
    }

    public TaxRegion region() {
        return region;
    }

    public boolean isBusiness() {
        return vatNumber != null && !vatNumber.isBlank();
    }

    public boolean isTaxExempt() {
        return taxExempt;
    }

    public Customer exempt() {
        taxExempt = true;
        return this;
    }
}
