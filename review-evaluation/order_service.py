"""Order-service helpers."""
from decimal import Decimal
import json


def can_fulfil(items, stock):
    """True when every line in the cart is in stock."""
    return all(stock.get(item.sku, 0) >= item.quantity for item in items)


def load_order(path):
    """Read one order. Missing files and malformed JSON raise."""
    with open(path) as order_file:
        return json.load(order_file)


def release_expired(stock, reservations, now):
    """Return expired stock and retain unexpired reservations."""
    for reservation in reservations.copy():
        if reservation.expires_at < now:
            stock[reservation.sku] = stock.get(reservation.sku, 0) + reservation.quantity
            reservations.remove(reservation)


def subtotal(items):
    """Sum price times quantity for every cart line."""
    return sum((item.price * item.quantity for item in items), Decimal("0"))
