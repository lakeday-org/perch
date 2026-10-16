package io.tallyho.billing.tax;

import static org.testng.Assert.assertEquals;

import io.tallyho.billing.domain.Customer;
import io.tallyho.billing.domain.TaxRegion;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;

public class RegionalTaxCalculatorTest {
    private RegionalTaxCalculator calculator;

    @BeforeMethod
    public void sellFromIreland() {
        calculator = new RegionalTaxCalculator(TaxRegion.EU_IE);
    }

    @DataProvider
    public Object[][] consumers() {
        return new Object[][] {
            {TaxRegion.US_CA, 100_00L, 7_25L},
            {TaxRegion.US_OR, 100_00L, 0L},
            {TaxRegion.EU_DE, 99_99L, 19_00L},
            {TaxRegion.UK, 12_345L, 2_469L},
        };
    }

    @Test(dataProvider = "consumers")
    public void chargesAConsumerTheirRegionsRate(TaxRegion region, long net, long tax) {
        assertEquals(calculator.taxOn(net, Customer.consumer("C-1", "Ada", region)), tax);
    }

    @Test
    public void reverseChargesAnEuBusinessInAnotherCountry() {
        Customer business = new Customer("C-2", "Muster GmbH", TaxRegion.EU_DE, "DE123456789");
        assertEquals(calculator.taxOn(100_00, business), 0);
    }

    @Test
    public void chargesAnEuBusinessInTheSellersOwnCountry() {
        Customer business = new Customer("C-3", "Dublin Ltd", TaxRegion.EU_IE, "IE1234567T");
        assertEquals(calculator.taxOn(100_00, business), 23_00);
    }

    @Test
    public void chargesNothingToAnExemptCustomer() {
        Customer charity = Customer.consumer("C-4", "Food Bank", TaxRegion.US_CA).exempt();
        assertEquals(calculator.taxOn(100_00, charity), 0);
    }
}
