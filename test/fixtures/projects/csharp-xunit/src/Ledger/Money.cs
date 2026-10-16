namespace Ledger;

/// <summary>An amount in minor units of one currency. Arithmetic across currencies is refused.</summary>
public readonly record struct Money(long Minor, Currency Currency) : IComparable<Money>
{
    public static Money Zero(Currency currency) => new(0, currency);

    /// <summary>Parses "12.34" in a currency, rejecting more decimals than the currency keeps.</summary>
    public static Money Parse(string amount, Currency currency)
    {
        var parts = amount.Split('.');
        if (parts.Length > 2) throw new FormatException($"not an amount: {amount}");
        var fraction = parts.Length == 2 ? parts[1] : "";
        if (fraction.Length > currency.Decimals) throw new FormatException($"{amount} has more decimals than {currency.Code}");
        var scale = (long)Math.Pow(10, currency.Decimals);
        var whole = long.Parse(parts[0]) * scale;
        var minor = fraction.Length == 0 ? 0 : long.Parse(fraction.PadRight(currency.Decimals, '0'));
        return new Money(whole < 0 ? whole - minor : whole + minor, currency);
    }

    public Money Plus(Money other)
    {
        if (other.Currency != Currency) throw new InvalidOperationException($"cannot add {other.Currency.Code} to {Currency.Code}");
        return new Money(Minor + other.Minor, Currency);
    }

    public Money Negate() => new(-Minor, Currency);

    /// <summary>Scales by a factor, rounding half to even as a ledger does.</summary>
    public Money Times(decimal factor)
    {
        var scaled = Math.Round(Minor * factor, 0, MidpointRounding.ToEven);
        return new Money((long)scaled, Currency);
    }

    public bool IsZero => Minor == 0;

    public bool IsNegative => Minor < 0;

    public int CompareTo(Money other)
    {
        if (other.Currency != Currency) throw new InvalidOperationException("cannot compare across currencies");
        return Minor.CompareTo(other.Minor);
    }

    public override string ToString()
    {
        var scale = (long)Math.Pow(10, Currency.Decimals);
        var magnitude = Math.Abs(Minor);
        var whole = magnitude / scale;
        var fraction = magnitude % scale;
        var digits = Currency.Decimals == 0 ? "" : "." + fraction.ToString().PadLeft(Currency.Decimals, '0');
        return $"{(Minor < 0 ? "-" : "")}{Currency.Symbol}{whole}{digits}";
    }
}
