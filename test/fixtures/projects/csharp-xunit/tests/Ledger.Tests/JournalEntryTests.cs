using Ledger.Journal;
using Xunit;

namespace Ledger.Tests;

public class JournalEntryTests
{
    private readonly JournalEntry _entry;
    private readonly Money _hundred = Money.Parse("100", Currency.USD);

    public JournalEntryTests()
    {
        _entry = new JournalEntry(new DateOnly(2024, 3, 1), "office chairs");
    }

    [Fact]
    public void ABalancedEntryValidates()
    {
        _entry.Debit("6100", _hundred).Credit("1000", _hundred);
        _entry.Validate();
        Assert.True(_entry.IsBalanced());
    }

    [Fact]
    public void AnUnbalancedEntryIsRefused()
    {
        _entry.Debit("6100", _hundred).Credit("1000", Money.Parse("90", Currency.USD));
        var error = Assert.Throws<UnbalancedEntryException>(() => _entry.Validate());
        Assert.Contains("$10.00", error.Message);
    }

    [Fact]
    public void AnEntryNeedsTwoLines()
    {
        _entry.Debit("6100", _hundred);
        Assert.Throws<UnbalancedEntryException>(() => _entry.Validate());
    }
}
