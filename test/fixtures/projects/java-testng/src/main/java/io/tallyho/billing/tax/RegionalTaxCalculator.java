package io.tallyho.billing.tax;

import io.tallyho.billing.domain.Customer;
import io.tallyho.billing.domain.TaxRegion;
import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Charges the customer's regional rate, rounded half up to the cent, except to an exempt customer, and to an EU business
 * outside the seller's own country, which accounts for the VAT itself by reverse charge.
 */
public class RegionalTaxCalculator implements TaxCalculator {
    private final TaxRegion sellerRegion;

    public RegionalTaxCalculator(TaxRegion sellerRegion) {
        this.sellerRegion = sellerRegion;
    }

    @Override
    public long taxOn(long netCents, Customer customer) {
        if (customer.isTaxExempt() || reverseCharge(customer)) {
            return 0;
        }
        return BigDecimal.valueOf(netCents).multiply(customer.region().rate()).setScale(0, RoundingMode.HALF_UP).longValueExact();
    }

    boolean reverseCharge(Customer customer) {
        return customer.isBusiness() && customer.region().isEu() && sellerRegion.isEu() && customer.region() != sellerRegion;
    }
}
