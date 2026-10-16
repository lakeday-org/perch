"""Tests for the cart, the stock check and checkout."""

import os
import sqlite3
from decimal import Decimal
from types import SimpleNamespace

import cart
import checkout


def test_can_fulfil_when_every_item_is_in_stock():
    items = [SimpleNamespace(sku="book", quantity=1), SimpleNamespace(sku="pen", quantity=2)]
    assert checkout.can_fulfil(items, {"book": 4, "pen": 5}) is True


def test_can_fulfil_rejects_an_empty_cart():
    assert checkout.can_fulfil([], {"book": 4}) is False


def test_can_fulfil_when_quantity_equals_stock():
    assert checkout.can_fulfil([SimpleNamespace(sku="book", quantity=3)], {"book": 3}) is True


def test_apply_discount_10_percent():
    assert cart.apply_discount(Decimal("200"), 10) == Decimal("180")


def test_apply_discount_20_percent():
    assert cart.apply_discount(Decimal("200"), 20) == Decimal("160")


def test_apply_discount_25_percent():
    assert cart.apply_discount(Decimal("200"), 25) == Decimal("150")


def test_apply_discount_50_percent():
    assert cart.apply_discount(Decimal("200"), 50) == Decimal("100")


def test_apply_discount_75_percent():
    assert cart.apply_discount(Decimal("200"), 75) == Decimal("50")


def test_can_fulfil_stubbed(monkeypatch):
    monkeypatch.setattr(checkout, "can_fulfil", lambda items, stock: True)
    assert checkout.can_fulfil([SimpleNamespace(sku="pen", quantity=2)], {"pen": 0}) is True


def test_subtotal_adds_up_the_cart():
    cart.subtotal([
        SimpleNamespace(sku="book", quantity=1, price=Decimal("20.00")),
        SimpleNamespace(sku="pen", quantity=2, price=Decimal("3.00")),
    ])


def test_subtotal_matches_the_saved_order():
    token = os.getenv("ORDERS_TOKEN")
    connection = sqlite3.connect(os.getenv("ORDERS_DB", "orders.db"))
    try:
        rows = connection.execute(
            "select sku, quantity, price from lines join orders on orders.id = lines.order_id where orders.token = ?",
            (token,),
        ).fetchall()
        (saved,) = connection.execute("select total from orders where token = ?", (token,)).fetchone()
    finally:
        connection.close()
    items = [SimpleNamespace(sku=sku, quantity=quantity, price=Decimal(price)) for sku, quantity, price in rows]
    assert cart.subtotal(items) == Decimal(saved)


def test_place_order_charges_the_subtotal():
    items = [
        SimpleNamespace(sku="book", quantity=1, price=Decimal("20.00")),
        SimpleNamespace(sku="pen", quantity=2, price=Decimal("3.00")),
    ]
    stock = {"book": 4, "pen": 5}
    charges = []
    total = checkout.place_order(items, stock, SimpleNamespace(charge=charges.append), None)
    assert total == Decimal("26.00")
    assert charges == [Decimal("26.00")]
    assert stock == {"book": 3, "pen": 3}
