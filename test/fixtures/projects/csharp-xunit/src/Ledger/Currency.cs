namespace Ledger;

public sealed record Currency(string Code, string Symbol, int Decimals)
{
    public static readonly Currency USD = new("USD", "$", 2);
    public static readonly Currency EUR = new("EUR", "€", 2);
    public static readonly Currency GBP = new("GBP", "£", 2);
    public static readonly Currency JPY = new("JPY", "¥", 0);

    private static readonly Currency[] Known = { USD, EUR, GBP, JPY };

    /// <summary>The currency booked under a code, or an error for one the ledger does not book in.</summary>
    public static Currency FromCode(string code)
    {
        foreach (var currency in Known)
        {
            if (currency.Code == code.ToUpperInvariant()) return currency;
        }
        throw new ArgumentException($"unknown currency {code}", nameof(code));
    }
}
