using Xunit;

namespace Ledger.Tests;

public class MoneyTests
{
    [Theory]
    [InlineData("12.34", "USD", 1234)]
    [InlineData("0.5", "EUR", 50)]
    [InlineData("7", "GBP", 700)]
    [InlineData("1500", "JPY", 1500)]
    public void ParsesDecimalStrings(string amount, string code, long minor)
    {
        Assert.Equal(minor, Money.Parse(amount, Currency.FromCode(code)).Minor);
    }

    [Theory]
    [InlineData("1.234")]
    [InlineData("0.001")]
    public void RejectsMoreDecimalsThanTheCurrencyHas(string amount)
    {
        Assert.Throws<FormatException>(() => Money.Parse(amount, Currency.USD));
    }

    [Fact]
    public void RefusesToAddAcrossCurrencies()
    {
        var dollars = Money.Parse("1", Currency.USD);
        var euros = Money.Parse("1", Currency.EUR);
        Assert.Throws<InvalidOperationException>(() => dollars.Plus(euros));
    }

    [Fact]
    public void RoundsHalfToEven()
    {
        Assert.Equal(2, new Money(5, Currency.USD).Times(0.5m).Minor);
        Assert.Equal(4, new Money(7, Currency.USD).Times(0.5m).Minor);
    }

    [Fact]
    public void FormatsANegativeAmountWithTheSignFirst()
    {
        Assert.Equal("-$1.50", Money.Parse("1.50", Currency.USD).Negate().ToString());
    }

    [Fact]
    public void ZeroIsNeitherNegativeNorNonZero()
    {
        var zero = Money.Zero(Currency.JPY);
        Assert.True(zero.IsZero);
        Assert.False(zero.IsNegative);
    }
}
