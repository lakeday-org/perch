using Ledger.Journal;

namespace Ledger;

/// <summary>The accounts and the entries posted to them, with a lock date before which nothing more may be posted.</summary>
public sealed class Book
{
    private readonly Dictionary<string, Account> _accounts = new();
    private readonly List<JournalEntry> _posted = new();
    private DateOnly? _lockedThrough;

    public Account Open(string code, string name, AccountType type, Currency currency)
    {
        if (_accounts.ContainsKey(code)) throw new ArgumentException($"{code} is already open", nameof(code));
        var account = new Account(code, name, type, currency);
        _accounts[code] = account;
        return account;
    }

    public Account AccountFor(string code)
    {
        if (!_accounts.TryGetValue(code, out var account)) throw new KeyNotFoundException($"no account {code}");
        return account;
    }

    public void Post(JournalEntry entry)
    {
        if (_lockedThrough is not null && entry.Date <= _lockedThrough) throw new InvalidOperationException($"{entry.Date} is locked");
        entry.Validate();
        foreach (var line in entry.Lines)
        {
            AccountFor(line.AccountCode).Apply(line);
        }
        _posted.Add(entry);
    }

    public Money Balance(string code) => AccountFor(code).Balance();

    /// <summary>Closes the period through a date; a date before the current lock is refused.</summary>
    public void ClosePeriod(DateOnly through)
    {
        if (_lockedThrough is not null && through < _lockedThrough) throw new InvalidOperationException("a period cannot be reopened");
        _lockedThrough = through;
    }

    public int PostedCount => _posted.Count;
}
