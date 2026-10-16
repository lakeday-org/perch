using Ledger;
using Ledger.Journal;

var book = new Book();
book.Open("1000", "Cash", AccountType.Asset, Currency.USD);
book.Open("4000", "Sales", AccountType.Revenue, Currency.USD);
for (var day = 1; day <= 5; day++)
{
    var amount = Money.Parse((day * 100).ToString(), Currency.USD);
    book.Post(new JournalEntry(new DateOnly(2024, 1, day), $"demo sale {day}").Debit("1000", amount).Credit("4000", amount));
}
Console.WriteLine($"posted {book.PostedCount} entries; cash {book.Balance("1000")}");
