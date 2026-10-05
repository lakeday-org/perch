namespace Billing.Terms;

/// <summary>When an invoice falls due and what it costs to be late: "net 30", "due on receipt", "2/10 net 30".</summary>
public sealed class PaymentTerms
{
    private PaymentTerms(int netDays, int discountDays, int discountPercent)
    {
        NetDays = netDays;
        DiscountDays = discountDays;
        DiscountPercent = discountPercent;
    }

    public int NetDays { get; }
    public int DiscountDays { get; }
    public int DiscountPercent { get; }

    public static PaymentTerms Parse(string text)
    {
        var words = text.Trim().ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 3 && words[0] == "due" && words[1] == "on" && words[2] == "receipt") return new PaymentTerms(0, 0, 0);
        if (words.Length == 2 && words[0] == "net") return new PaymentTerms(int.Parse(words[1]), 0, 0);
        if (words.Length == 3 && words[1] == "net" && words[0].Contains('/'))
        {
            var early = words[0].Split('/');
            return new PaymentTerms(int.Parse(words[2]), int.Parse(early[1]), int.Parse(early[0]));
        }
        throw new FormatException($"unknown payment terms: {text}");
    }

    public DateOnly DueDate(DateOnly issued) => issued.AddDays(NetDays);

    /// <summary>What early payment saves: the discount while it lasts, nothing after.</summary>
    public decimal EarlyPaymentDiscount(decimal amount, DateOnly issued, DateOnly paidOn)
    {
        if (DiscountPercent == 0 || paidOn > issued.AddDays(DiscountDays)) return 0;
        return Math.Round(amount * DiscountPercent / 100, 2, MidpointRounding.ToEven);
    }

    /// <summary>A late fee of 1.5% per whole month overdue, compounding monthly.</summary>
    public static decimal LateFee(decimal balance, int daysLate)
    {
        var months = daysLate / 30;
        var owed = balance;
        for (var month = 0; month < months; month++) owed *= 1.015m;
        return Math.Round(owed - balance, 2, MidpointRounding.ToEven);
    }
}
