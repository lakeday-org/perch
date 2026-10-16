# governor

Rate limiting for Python services.

```python
from governor import TokenBucket, limit

per_user = TokenBucket("20/minute", burst=5)

@limit(per_user, key=lambda request: request.user_id)
def search(request):
    ...
```

Limits are kept in memory by default; pass `storage=RedisStorage(client)` to share them between processes.

## Tests

```sh
python -m unittest discover -s tests -t .
```
