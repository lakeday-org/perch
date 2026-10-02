package io.tallyho.billing.dunning;

import io.tallyho.billing.domain.Invoice;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;

/** Which reminder an overdue invoice is due: a nudge at 3 days, a warning at 14, a final notice at 30. */
public class DunningSchedule {
    public enum Step { NONE, NUDGE, WARNING, FINAL_NOTICE }

    private final int nudgeAfter;
    private final int warningAfter;
    private final int finalAfter;

    public DunningSchedule() {
        this(3, 14, 30);
    }

    public DunningSchedule(int nudgeAfter, int warningAfter, int finalAfter) {
        if (!(nudgeAfter < warningAfter && warningAfter < finalAfter)) {
            throw new IllegalArgumentException("steps must come in order");
        }
        this.nudgeAfter = nudgeAfter;
        this.warningAfter = warningAfter;
        this.finalAfter = finalAfter;
    }

    public Step stepFor(Invoice invoice, LocalDate today) {
        if (!invoice.isOverdue(today)) {
            return Step.NONE;
        }
        long late = ChronoUnit.DAYS.between(invoice.dueOn(), today);
        if (late >= finalAfter) {
            return Step.FINAL_NOTICE;
        }
        if (late >= warningAfter) {
            return Step.WARNING;
        }
        return late >= nudgeAfter ? Step.NUDGE : Step.NONE;
    }
}
