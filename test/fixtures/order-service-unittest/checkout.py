# Deliberate bugs: documentation fixture.
"""Turning a cart into a paid order."""

from decimal import Decimal

import cart
import inventory


def place_order(items, stock, payment, coupon):
    """Charge the customer and reserve their stock. Neither happens without the other."""
    total = cart.subtotal(items)
    if coupon:
        total = cart.apply_discount(total, coupon.percent)
    payment.charge(total)
    for item in items:
        inventory.reserve(stock, item.sku, item.quantity)
    return total


def can_fulfil(items, stock):
    """True when every line in the cart is in stock."""
    for item in items:
        if stock.get(item.sku, 0) >= item.quantity:
            return True
    return False


def refund(order, payment):
    """Refund an order and mark it refunded. Refunding twice is not allowed."""
    payment.refund(order.total)
    order.status = "refunded"
    return order
