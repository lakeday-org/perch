# tally

Double-entry bookkeeping and invoicing for small businesses.

```python
import tally
from decimal import Decimal

books = tally.open_ledger("USD")
invoice = tally.Invoice("Acme Corp")
invoice.add("Consulting", Decimal("10"), tally.Money("150.00", "USD"))
books.post(invoice.to_entry())
print(books.balance("1200"))  # 1650.00 USD
```

## Development

```sh
pip install -e '.[test]'
pytest --cov
```
