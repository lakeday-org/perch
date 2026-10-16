using Billing.Terms;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Billing.Tests;

[TestClass]
public class PaymentTermsTests
{
    [DataTestMethod]
    [DataRow("net 30", 30)]
    [DataRow("Net 15", 15)]
    [DataRow("due on receipt", 0)]
    [DataRow("2/10 net 30", 30)]
    public void ParsesTheNetDays(string text, int netDays)
    {
        Assert.AreEqual(netDays, PaymentTerms.Parse(text).NetDays);
    }

    [TestMethod]
    public void UnknownTermsAreRefused()
    {
        Assert.ThrowsException<FormatException>(() => PaymentTerms.Parse("whenever"));
    }

    [TestMethod]
    public void EarlyPaymentEarnsTheDiscountOnlyWhileItLasts()
    {
        var terms = PaymentTerms.Parse("2/10 net 30");
        var issued = new DateOnly(2024, 5, 1);
        Assert.AreEqual(2m, terms.EarlyPaymentDiscount(100m, issued, new DateOnly(2024, 5, 10)));
        Assert.AreEqual(0m, terms.EarlyPaymentDiscount(100m, issued, new DateOnly(2024, 5, 12)));
    }

    [DataTestMethod]
    [DataRow(29, 0)]
    [DataRow(30, 1.5)]
    [DataRow(60, 3.02)]
    public void LateFeesCompoundMonthly(int daysLate, double fee)
    {
        Assert.AreEqual((decimal)fee, PaymentTerms.LateFee(100m, daysLate));
    }
}
