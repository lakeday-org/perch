using Ledger.Journal;
using Xunit;

namespace Ledger.Tests;

public class BookTests
{
    private readonly Book _book = new();

    public BookTests()
    {
        _book.Open("1000", "Cash", AccountType.Asset, Currency.USD);
        _book.Open("4000", "Sales", AccountType.Revenue, Currency.USD);
    }

    private static JournalEntry Sale(Money amount) =>
        new JournalEntry(new DateOnly(2024, 3, 5), "sale").Debit("1000", amount).Credit("4000", amount);

    [Fact]
    public void PostingMovesBothBalances()
    {
        _book.Post(Sale(Money.Parse("250", Currency.USD)));
        Assert.Equal("$250.00", _book.Balance("1000").ToString());
        Assert.Equal("$250.00", _book.Balance("4000").ToString());
    }

    [Fact]
    public void PostingIntoAClosedPeriodIsRefused()
    {
        _book.ClosePeriod(new DateOnly(2024, 3, 31));
        Assert.Throws<InvalidOperationException>(() => _book.Post(Sale(Money.Parse("1", Currency.USD))));
    }

    [Fact]
    public void AFrozenAccountRefusesEntries()
    {
        _book.AccountFor("1000").Freeze();
        Assert.Throws<InvalidOperationException>(() => _book.Post(Sale(Money.Parse("1", Currency.USD))));
    }

    [Fact]
    public void APeriodCannotBeReopened()
    {
        _book.ClosePeriod(new DateOnly(2024, 3, 31));
        Assert.Throws<InvalidOperationException>(() => _book.ClosePeriod(new DateOnly(2024, 2, 28)));
    }
}
