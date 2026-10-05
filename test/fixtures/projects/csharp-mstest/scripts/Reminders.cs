using Billing;
using Billing.Terms;

// A one-off script run with `dotnet run` from this directory: lists the late fee owed on each balance given. Not a test.
var today = DateOnly.FromDateTime(DateTime.Today);
foreach (var argument in args)
{
    var parts = argument.Split(':');
    var issued = DateOnly.Parse(parts[0]);
    var balance = decimal.Parse(parts[1]);
    var daysLate = today.DayNumber - PaymentTerms.Parse("net 30").DueDate(issued).DayNumber;
    Console.WriteLine($"{issued}: {balance:C} owes {PaymentTerms.LateFee(balance, daysLate):C} in late fees");
}
