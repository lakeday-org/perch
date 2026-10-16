using Billing.Terms;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Billing.Tests;

[TestClass]
public class InvoiceTests
{
    private Invoice _invoice = null!;

    [TestInitialize]
    public void NewInvoice()
    {
        _invoice = new Invoice("Acme", PaymentTerms.Parse("net 30"));
    }

    [TestMethod]
    public void SubtotalAppliesLineDiscounts()
    {
        _invoice.Add(new LineItem("chairs", 4, 50m, 10)).Add(new LineItem("desk", 1, 300m));
        Assert.AreEqual(480m, _invoice.Subtotal());
    }

    [TestMethod]
    public void TaxesAndTotal()
    {
        _invoice.Add(new LineItem("desk", 1, 100m)).Taxed(new TaxRule("GST", 0.05m)).Taxed(new TaxRule("PST", 0.07m));
        Assert.AreEqual(12m, _invoice.Taxes());
        Assert.AreEqual(112m, _invoice.Total());
    }

    [TestMethod]
    public void AnEmptyInvoiceCannotBeIssued()
    {
        Assert.ThrowsException<InvalidOperationException>(() => _invoice.Issue(new DateOnly(2024, 5, 1)));
    }

    [TestMethod]
    public void PartialPaymentLeavesABalance()
    {
        _invoice.Add(new LineItem("desk", 1, 100m));
        _invoice.Issue(new DateOnly(2024, 5, 1));
        _invoice.RecordPayment(40m);
        Assert.AreEqual(60m, _invoice.BalanceDue());
        Assert.AreEqual(InvoiceStatus.Issued, _invoice.Status);
        Assert.AreEqual(new DateOnly(2024, 5, 31), _invoice.DueDate());
    }
}
