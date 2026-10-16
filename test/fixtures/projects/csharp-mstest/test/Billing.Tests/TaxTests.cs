using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Billing.Tests;

[TestClass]
public class TaxTests
{
    private static readonly TaxRule Gst = new("GST", 0.05m);
    private static readonly TaxRule Qst = new("QST", 0.09975m, Compound: true);

    [TestMethod]
    public void ChargesEachRuleOnTheNet()
    {
        Assert.AreEqual(5m, Tax.For(100m, new[] { Gst }));
    }

    [TestMethod]
    public void ACompoundRuleIsChargedOnTheTaxToo()
    {
        Assert.AreEqual(15.47m, Tax.For(100m, new[] { Gst, Qst }));
    }

    [TestMethod]
    public void NothingIsExemptButNothing()
    {
        Assert.IsTrue(Tax.IsExempt(0m));
        Assert.IsFalse(Tax.IsExempt(0.01m));
    }

    [TestMethod]
    public void ADiscountedLineIsTaxedOnItsNet()
    {
        var line = new LineItem("chairs", 2, 50m, 50);
        Assert.AreEqual(2.5m, Tax.For(line.Net(), new[] { Gst }));
    }
}
