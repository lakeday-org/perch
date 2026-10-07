import math


class RateLimitExceeded(Exception):
    """Raised by `Limiter.check` when a key has used up its rate."""

    def __init__(self, key: str, limit: str, retry_after: float) -> None:
        super().__init__(key, limit, retry_after)
        self.key = key
        self.limit = limit
        self.retry_after = retry_after

    def __str__(self) -> str:
        return f"{self.key} is over {self.limit}; retry in {math.ceil(self.retry_after)}s"
