"""Counters in Redis, shared by every process that points at the same server."""
import json
from typing import Any, Optional


class RedisStorage:
    def __init__(self, client, prefix: str = "governor:") -> None:
        self.client = client
        self.prefix = prefix

    def _key(self, key: str) -> str:
        return f"{self.prefix}{key}"

    def get(self, key: str, default: Any = None) -> Any:
        raw = self.client.get(self._key(key))
        if raw is None:
            return default
        return json.loads(raw)

    def set(self, key: str, value: Any, ttl: Optional[float] = None) -> None:
        if ttl is None:
            self.client.set(self._key(key), json.dumps(value))
        else:
            self.client.set(self._key(key), json.dumps(value), px=max(int(ttl * 1000), 1))

    def incr(self, key: str, amount: int = 1, ttl: Optional[float] = None) -> int:
        pipe = self.client.pipeline()
        pipe.incrby(self._key(key), amount)
        if ttl is not None:
            pipe.pexpire(self._key(key), max(int(ttl * 1000), 1), nx=True)
        count, *_ = pipe.execute()
        return int(count)

    def delete(self, key: str) -> None:
        self.client.delete(self._key(key))
