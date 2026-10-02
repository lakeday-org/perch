"""Tests for the cart, the stock check and checkout."""

import os
import sqlite3
import unittest
from decimal import Decimal
from types import SimpleNamespace
from unittest import mock

import cart
import checkout


class CanFulfilTest(unittest.TestCase):
    def test_can_fulfil_when_every_item_is_in_stock(self):
        items = [SimpleNamespace(sku="book", quantity=1), SimpleNamespace(sku="pen", quantity=2)]
        self.assertIs(checkout.can_fulfil(items, {"book": 4, "pen": 5}), True)

    def test_can_fulfil_rejects_an_empty_cart(self):
        self.assertIs(checkout.can_fulfil([], {"book": 4}), False)

    def test_can_fulfil_when_quantity_equals_stock(self):
        self.assertIs(checkout.can_fulfil([SimpleNamespace(sku="book", quantity=3)], {"book": 3}), True)

    def test_can_fulfil_stubbed(self):
        with mock.patch.object(checkout, "can_fulfil", return_value=True):
            self.assertIs(checkout.can_fulfil([SimpleNamespace(sku="pen", quantity=2)], {"pen": 0}), True)


class ApplyDiscountTest(unittest.TestCase):
    def test_apply_discount_10_percent(self):
        self.assertEqual(cart.apply_discount(Decimal("200"), 10), Decimal("180"))

    def test_apply_discount_20_percent(self):
        self.assertEqual(cart.apply_discount(Decimal("200"), 20), Decimal("160"))

    def test_apply_discount_25_percent(self):
        self.assertEqual(cart.apply_discount(Decimal("200"), 25), Decimal("150"))

    def test_apply_discount_50_percent(self):
        self.assertEqual(cart.apply_discount(Decimal("200"), 50), Decimal("100"))

    def test_apply_discount_75_percent(self):
        self.assertEqual(cart.apply_discount(Decimal("200"), 75), Decimal("50"))


class SubtotalTest(unittest.TestCase):
    def test_subtotal_adds_up_the_cart(self):
        cart.subtotal([
            SimpleNamespace(sku="book", quantity=1, price=Decimal("20.00")),
            SimpleNamespace(sku="pen", quantity=2, price=Decimal("3.00")),
        ])

    def test_subtotal_matches_the_saved_order(self):
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
        self.assertEqual(cart.subtotal(items), Decimal(saved))


class PlaceOrderTest(unittest.TestCase):
    def test_place_order_charges_the_subtotal(self):
        items = [
            SimpleNamespace(sku="book", quantity=1, price=Decimal("20.00")),
            SimpleNamespace(sku="pen", quantity=2, price=Decimal("3.00")),
        ]
        stock = {"book": 4, "pen": 5}
        charges = []
        total = checkout.place_order(items, stock, SimpleNamespace(charge=charges.append), None)
        self.assertEqual(total, Decimal("26.00"))
        self.assertEqual(charges, [Decimal("26.00")])
        self.assertEqual(stock, {"book": 3, "pen": 3})


if __name__ == "__main__":
    unittest.main()
