"""WSGI middleware that limits every request and answers 429 when a client is over."""
from typing import Callable, Iterable, Optional

from .algorithms.base import Limiter
from .headers import rate_limit_headers
from .keys import remote_addr


class RateLimitMiddleware:
    def __init__(self, app: Callable, limiter: Limiter, *, key: Optional[Callable[[dict], str]] = None, exempt: Iterable[str] = ("/healthz",)) -> None:
        self.app = app
        self.limiter = limiter
        self.key = key or remote_addr
        self.exempt = tuple(exempt)

    def __call__(self, environ: dict, start_response: Callable):
        path = environ.get("PATH_INFO", "/")
        if path.startswith(self.exempt):
            return self.app(environ, start_response)
        decision = self.limiter.hit(self.key(environ))
        headers = list(rate_limit_headers(decision).items())
        if not decision.allowed:
            return self._too_many(start_response, headers)

        def start_with_headers(status, response_headers, exc_info=None):
            return start_response(status, list(response_headers) + headers, exc_info)

        return self.app(environ, start_with_headers)

    def _too_many(self, start_response: Callable, headers: list):
        body = b"Too many requests\n"
        start_response("429 Too Many Requests", [("Content-Type", "text/plain"), ("Content-Length", str(len(body)))] + headers)
        return [body]
