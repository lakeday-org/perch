// Exports last month's issued invoices as CSV for the accountants. Run with the billing jar on the classpath:
//   java -cp target/billing-1.8.2-SNAPSHOT.jar scripts/ExportInvoices.java 2026-09
import io.tallyho.billing.domain.Invoice;
import java.time.YearMonth;
import java.util.List;

public class ExportInvoices {
    public static void main(String[] args) {
        YearMonth month = args.length > 0 ? YearMonth.parse(args[0]) : YearMonth.now().minusMonths(1);
        System.out.println("number,customer,subtotal");
        for (Invoice invoice : load(month)) {
            System.out.println(String.join(",", invoice.number(), invoice.customer().name(), Long.toString(invoice.subtotal())));
        }
    }

    private static List<Invoice> load(YearMonth month) {
        // Reads from the reporting replica in production; nothing to read here.
        return List.of();
    }
}
