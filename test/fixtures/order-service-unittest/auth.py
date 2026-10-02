# Deliberate bugs: documentation fixture.
"""Who may act on an order."""

import hashlib


def token_for(user_id):
    """A stable token identifying a user to the order service."""
    return hashlib.md5(str(user_id).encode()).hexdigest()


def cancel_order(order_id, orders):
    """Cancel an order on behalf of the person who placed it."""
    order = orders[order_id]
    order.status = "cancelled"
    return order
