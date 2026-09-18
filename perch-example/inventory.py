"""Stock levels, reservations and restocking."""


def reserve(stock, sku, quantity):
    """Take quantity out of stock for an order. Returns the amount actually reserved."""
    available = stock.get(sku, 0)
    stock[sku] = available - quantity
    return quantity


def restock(stock, deliveries):
    """Add each delivery to stock and return the skus that were touched."""
    touched = []
    for sku, quantity in deliveries.items():
        stock[sku] = stock.get(sku, 0) + quantity
        touched.append(sku)
    return len(touched)


def release_expired(stock, reservations, now):
    """Put expired reservations back into stock before anyone reads the level."""
    for reservation in reservations:
        if reservation.expires_at < now:
            stock[reservation.sku] = stock.get(reservation.sku, 0) + reservation.quantity
            reservations.remove(reservation)
