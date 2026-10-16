namespace Billing;

/// <summary>One line of an invoice: a quantity of something at a unit price, less a discount in percent.</summary>
public sealed class LineItem
{
    public LineItem(string description, int quantity, decimal unitPrice, int discountPercent = 0)
    {
        if (quantity <= 0) throw new ArgumentOutOfRangeException(nameof(quantity), "a line needs a positive quantity");
        if (discountPercent < 0 || discountPercent > 100) throw new ArgumentOutOfRangeException(nameof(discountPercent), "a discount is 0 to 100 percent");
        Description = description;
        Quantity = quantity;
        UnitPrice = unitPrice;
        DiscountPercent = discountPercent;
    }

    public string Description { get; }
    public int Quantity { get; }
    public decimal UnitPrice { get; }
    public int DiscountPercent { get; }

    public decimal Gross() => Quantity * UnitPrice;

    /// <summary>The gross less the discount, rounded to cents.</summary>
    public decimal Net()
    {
        var discounted = Gross() * (100 - DiscountPercent) / 100;
        return Math.Round(discounted, 2, MidpointRounding.ToEven);
    }
}
