namespace Ledger;

public enum AccountType { Asset, Liability, Equity, Revenue, Expense }

public static class AccountTypes
{
    /// <summary>Assets and expenses grow with debits; the rest grow with credits.</summary>
    public static bool IsDebitNormal(this AccountType type) => type == AccountType.Asset || type == AccountType.Expense;
}

public sealed class Account
{
    private Money _balance;
    private bool _frozen;

    public Account(string code, string name, AccountType type, Currency currency)
    {
        if (string.IsNullOrWhiteSpace(code)) throw new ArgumentException("an account needs a code", nameof(code));
        Code = code;
        Name = name;
        Type = type;
        _balance = Money.Zero(currency);
    }

    public string Code { get; }
    public string Name { get; }
    public AccountType Type { get; }
    public Currency Currency => _balance.Currency;

    public Money Balance() => _balance;

    public void Freeze() => _frozen = true;

    /// <summary>Applies one side of an entry: a debit raises a debit-normal account and lowers the others.</summary>
    public void Apply(Journal.Entry entry)
    {
        if (_frozen) throw new InvalidOperationException($"{Code} is frozen");
        var raises = entry.Side == Journal.Side.Debit == Type.IsDebitNormal();
        _balance = _balance.Plus(raises ? entry.Amount : entry.Amount.Negate());
    }
}
