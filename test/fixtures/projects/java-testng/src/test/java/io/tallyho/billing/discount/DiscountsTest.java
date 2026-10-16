package io.tallyho.billing.discount;

import static org.testng.Assert.assertEquals;

import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;

public class DiscountsTest {

    @DataProvider(name = "codes")
    public static Object[][] codes() {
        return new Object[][] {
            {"SAVE10", 100_00L, 90_00L},
            {" save25 ", 100_00L, 75_00L},
            {"VOLUME", 500_00L, 500_00L},
            {"VOLUME", 6_000_00L, 5_400_00L},
            {"volume", 25_000_00L, 21_250_00L},
        };
    }

    @Test(dataProvider = "codes")
    public void appliesWhatACodeStandsFor(String code, long subtotal, long expected) {
        assertEquals(Discounts.fromCode(code).apply(subtotal), expected);
    }

    @Test(expectedExceptions = IllegalArgumentException.class, expectedExceptionsMessageRegExp = "unknown promotion code: FREE")
    public void rejectsAnUnknownCode() {
        Discounts.fromCode("FREE");
    }

    @Test(expectedExceptions = IllegalArgumentException.class)
    public void rejectsAHundredPercentOff() {
        Discounts.percent(100);
    }

    @Test
    public void roundsAPercentageInTheCustomersFavour() {
        assertEquals(new PercentageDiscount(15).apply(9_99), 8_50);
    }

    @Test
    public void describesTheTiers() {
        assertEquals(new TieredDiscount().tier(1_000, 5).describe(), "tiered: {1000=5}");
    }
}
