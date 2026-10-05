namespace Ledger.Journal;

public sealed class UnbalancedEntryException : Exception
{
    public UnbalancedEntryException(string message) : base(message) { }
}

/// <summary>A dated set of lines whose debits must equal their credits before it is posted.</summary>
public sealed class JournalEntry
{
    private readonly List<Entry> _lines = new();

    public JournalEntry(DateOnly date, string memo)
    {
        Date = date;
        Memo = memo;
    }

    public DateOnly Date { get; }
    public string Memo { get; }
    public IReadOnlyList<Entry> Lines => _lines;

    public JournalEntry Debit(string accountCode, Money amount)
    {
        _lines.Add(Entry.Debit(accountCode, amount));
        return this;
    }

    public JournalEntry Credit(string accountCode, Money amount)
    {
        _lines.Add(Entry.Credit(accountCode, amount));
        return this;
    }

    /// <summary>Debits less credits, which a balanced entry makes zero.</summary>
    public Money Imbalance()
    {
        if (_lines.Count == 0) throw new UnbalancedEntryException("an entry needs at least two lines");
        var total = Money.Zero(_lines[0].Amount.Currency);
        foreach (var line in _lines)
        {
            total = total.Plus(line.Side == Side.Debit ? line.Amount : line.Amount.Negate());
        }
        return total;
    }

    public bool IsBalanced() => _lines.Count >= 2 && Imbalance().IsZero;

    public void Validate()
    {
        if (_lines.Count < 2) throw new UnbalancedEntryException("an entry needs at least two lines");
        var imbalance = Imbalance();
        if (!imbalance.IsZero) throw new UnbalancedEntryException($"entry is off by {imbalance}");
    }
}
