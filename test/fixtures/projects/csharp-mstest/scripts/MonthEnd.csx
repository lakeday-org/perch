#r "../src/Billing/bin/Debug/net8.0/Billing.dll"
using Billing;
using Billing.Terms;

// Issues one invoice per customer named on the command line and prints what each owes, for the month-end run. Not a test.
foreach (var customer in Args)
{
    var invoice = new Invoice(customer, PaymentTerms.Parse("net 30")).Add(new LineItem("retainer", 1, 1500m));
    invoice.Issue(DateOnly.FromDateTime(DateTime.Today));
    Console.WriteLine($"{customer}: {invoice.Total():C} due {invoice.DueDate()}");
}
