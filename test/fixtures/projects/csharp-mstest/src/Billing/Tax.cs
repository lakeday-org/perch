namespace Billing;

/// <summary>A tax by name and rate, charged on a net amount.</summary>
public sealed record TaxRule(string Name, decimal Rate, bool Compound = false);

public static class Tax
{
    /// <summary>Tax for a net amount under a list of rules: a compound rule is charged on the tax so far as well.</summary>
    public static decimal For(decimal net, IReadOnlyList<TaxRule> rules)
    {
        decimal total = 0;
        foreach (var rule in rules)
        {
            var taxable = rule.Compound ? net + total : net;
            total += Math.Round(taxable * rule.Rate, 2, MidpointRounding.ToEven);
        }
        return total;
    }

    public static bool IsExempt(decimal net) => net <= 0;
}
