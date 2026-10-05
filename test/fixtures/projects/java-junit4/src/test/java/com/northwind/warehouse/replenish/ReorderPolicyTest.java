package com.northwind.warehouse.replenish;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.Collection;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameters;

@RunWith(Parameterized.class)
public class ReorderPolicyTest {

    @Parameters
    public static Collection<Object[]> policies() {
        return Arrays.asList(new Object[][] {
            // daily demand, lead time, safety stock, case size, available, on order, reorder point, order quantity (7-day review)
            {4.0, 5, 10, 12, 30, 0, 30, 36},
            {4.0, 5, 10, 12, 31, 0, 30, 0},
            {2.5, 3, 0, 1, 2, 3, 8, 21},
            {0.0, 10, 5, 6, 5, 0, 5, 0},
        });
    }

    private final ReorderPolicy policy;
    private final int available;
    private final int onOrder;
    private final int reorderPoint;
    private final int orderQuantity;

    public ReorderPolicyTest(double demand, int leadTime, int safety, int caseSize, int available, int onOrder, int reorderPoint, int orderQuantity) {
        this.policy = new ReorderPolicy(demand, leadTime, safety, caseSize);
        this.available = available;
        this.onOrder = onOrder;
        this.reorderPoint = reorderPoint;
        this.orderQuantity = orderQuantity;
    }

    @Test
    public void computesTheReorderPoint() {
        assertEquals(reorderPoint, policy.reorderPoint());
    }

    @Test
    public void ordersWholeCasesToCoverTheReviewPeriod() {
        assertEquals(orderQuantity, policy.orderQuantity(available, onOrder, 7));
    }
}
