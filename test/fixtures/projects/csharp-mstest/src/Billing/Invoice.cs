using Billing.Terms;

namespace Billing;

public enum InvoiceStatus { Draft, Issued, Paid }

/// <summary>Lines, taxes and payments against one customer, issued once and paid down to zero.</summary>
public sealed class Invoice
{
    private readonly List<LineItem> _lines = new();
    private readonly List<TaxRule> _taxes = new();
    private decimal _paid;

    public Invoice(string customer, PaymentTerms terms)
    {
        Customer = customer;
        Terms = terms;
    }

    public string Customer { get; }
    public PaymentTerms Terms { get; }
    public InvoiceStatus Status { get; private set; } = InvoiceStatus.Draft;
    public DateOnly? IssuedOn { get; private set; }

    public Invoice Add(LineItem line)
    {
        if (Status != InvoiceStatus.Draft) throw new InvalidOperationException("an issued invoice cannot change");
        _lines.Add(line);
        return this;
    }

    public Invoice Taxed(TaxRule rule)
    {
        _taxes.Add(rule);
        return this;
    }

    public decimal Subtotal()
    {
        decimal total = 0;
        foreach (var line in _lines) total += line.Net();
        return total;
    }

    public decimal Taxes() => Tax.IsExempt(Subtotal()) ? 0 : Tax.For(Subtotal(), _taxes);

    public decimal Total() => Subtotal() + Taxes();

    public void Issue(DateOnly on)
    {
        if (_lines.Count == 0) throw new InvalidOperationException("an empty invoice cannot be issued");
        Status = InvoiceStatus.Issued;
        IssuedOn = on;
    }

    public DateOnly DueDate() => IssuedOn is DateOnly issued ? Terms.DueDate(issued) : throw new InvalidOperationException("not issued");

    public void RecordPayment(decimal amount)
    {
        if (Status == InvoiceStatus.Draft) throw new InvalidOperationException("a draft cannot be paid");
        _paid += amount;
        if (BalanceDue() <= 0) Status = InvoiceStatus.Paid;
    }

    public decimal BalanceDue() => Total() - _paid;
}
