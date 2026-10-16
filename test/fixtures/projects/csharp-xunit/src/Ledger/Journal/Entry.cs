namespace Ledger.Journal;

public enum Side { Debit, Credit }

/// <summary>One line of a journal entry: an amount on one side of one account.</summary>
public sealed record Entry(string AccountCode, Side Side, Money Amount)
{
    public static Entry Debit(string accountCode, Money amount) => new(accountCode, Side.Debit, amount);

    public static Entry Credit(string accountCode, Money amount) => new(accountCode, Side.Credit, amount);
}
