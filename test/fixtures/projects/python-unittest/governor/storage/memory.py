"""Counters in a dict, for one process. Expired keys are dropped when read."""
import threading
from typing import Any, Dict, Optional

from ..clock import Clock, SystemClock


class MemoryStorage:
    def __init__(self, clock: Optional[Clock] = None) -> None:
        self.clock = clock or SystemClock()
        self._data: Dict[str, Any] = {}
        self._expires: Dict[str, float] = {}
        self._lock = threading.RLock()

    def __len__(self) -> int:
        return len(self._data)

    def _live(self, key: str) -> bool:
        expires = self._expires.get(key)
        if expires is not None and expires <= self.clock.now():
            self._data.pop(key, None)
            self._expires.pop(key, None)
            return False
        return key in self._data

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._data[key] if self._live(key) else default

    def set(self, key: str, value: Any, ttl: Optional[float] = None) -> None:
        with self._lock:
            self._data[key] = value
            if ttl is None:
                self._expires.pop(key, None)
            else:
                self._expires[key] = self.clock.now() + ttl

    def incr(self, key: str, amount: int = 1, ttl: Optional[float] = None) -> int:
        """Adds to a counter, starting it at zero; the expiry is set when the counter starts and kept after."""
        with self._lock:
            if not self._live(key):
                self.set(key, 0, ttl)
            self._data[key] += amount
            return self._data[key]

    def delete(self, key: str) -> None:
        with self._lock:
            self._data.pop(key, None)
            self._expires.pop(key, None)

    def sweep(self) -> int:
        """Drops every expired key now rather than when it is next read; returns how many went."""
        with self._lock:
            dead = [key for key in list(self._data) if not self._live(key)]
            return len(dead)
