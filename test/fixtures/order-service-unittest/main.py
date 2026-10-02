"""Demonstrate the mixed-stock order accepted by the deliberate fixture bug."""
from types import SimpleNamespace
from checkout import can_fulfil

if __name__ == "__main__":
    items = [SimpleNamespace(sku="book", quantity=1), SimpleNamespace(sku="pen", quantity=2)]
    print(f"Mixed-stock order accepted: {can_fulfil(items, {'book': 4, 'pen': 0})}")
