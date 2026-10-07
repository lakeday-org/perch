import unittest

from governor.algorithms.fixed_window import FixedWindow
from governor.middleware import RateLimitMiddleware
from governor.storage.memory import MemoryStorage
from governor.testing import FakeClock


def hello(environ, start_response):
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [b"hello\n"]


class Recorder:
    def __init__(self):
        self.status = None
        self.headers = None

    def __call__(self, status, headers, exc_info=None):
        self.status, self.headers = status, dict(headers)


class RateLimitMiddlewareTest(unittest.TestCase):
    def setUp(self):
        clock = FakeClock()
        self.app = RateLimitMiddleware(hello, FixedWindow("2/minute", storage=MemoryStorage(clock), clock=clock))

    def request(self, path="/"):
        recorder = Recorder()
        body = self.app({"PATH_INFO": path, "REMOTE_ADDR": "192.0.2.1"}, recorder)
        return recorder, b"".join(body)

    def test_over_the_limit_is_answered_429(self):
        self.request()
        ok, _ = self.request()
        self.assertEqual(ok.status, "200 OK")
        self.assertEqual(ok.headers["RateLimit-Remaining"], "0")
        refused, body = self.request()
        self.assertTrue(refused.status.startswith("429"))
        self.assertIn("Retry-After", refused.headers)
        self.assertEqual(body, b"Too many requests\n")

    def test_health_checks_are_exempt(self):
        for _ in range(5):
            recorder, _ = self.request("/healthz")
            self.assertEqual(recorder.status, "200 OK")
            self.assertNotIn("RateLimit-Limit", recorder.headers)
