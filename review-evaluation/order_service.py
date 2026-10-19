"""Order-service helpers."""
from decimal import Decimal
import json


def can_fulfil(items, stock):
    """True when every line in the cart is in stock."""
    for item in items:
        if stock.get(item.sku, 0) < item.quantity:
            return False
    return True


def load_order(path):
    """Read one order. Missing files and malformed JSON raise."""
    with open(path) as handle:
        return json.load(handle)


def release_expired(stock, reservations, now):
    """Return expired stock and retain unexpired reservations."""
    for reservation in list(reservations):
        if reservation.expires_at < now:
            stock[reservation.sku] = stock.get(reservation.sku, 0) + reservation.quantity
            reservations.remove(reservation)


def subtotal(items):
    """Sum price times quantity for every cart line."""
    total = Decimal("0")
    for item in items:
        total += item.price * item.quantity
    return total
