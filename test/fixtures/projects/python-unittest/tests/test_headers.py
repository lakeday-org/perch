import unittest
from datetime import datetime, timezone

from governor.algorithms.base import Decision
from governor.headers import format_seconds, parse_retry_after, rate_limit_headers


class TestHeaders(unittest.TestCase):
    def test_allowed_decision(self):
        headers = rate_limit_headers(Decision(True, 100, 42, 30.2), policy="100;w=60")
        self.assertEqual(headers, {"RateLimit-Limit": "100", "RateLimit-Remaining": "42", "RateLimit-Reset": "31", "RateLimit-Policy": "100;w=60"})

    def test_refusal_adds_retry_after(self):
        headers = rate_limit_headers(Decision(False, 100, 0, 30, 0.2))
        self.assertEqual(headers["Retry-After"], "1")

    def test_format_seconds(self):
        for seconds, text in [(0, "0"), (-3, "0"), (0.01, "1"), (1.0, "1"), (59.5, "60")]:
            with self.subTest(seconds=seconds):
                self.assertEqual(format_seconds(seconds), text)

    def test_parse_retry_after(self):
        now = datetime(2026, 10, 21, 7, 28, 0, tzinfo=timezone.utc)
        self.assertEqual(parse_retry_after("120", now), 120.0)
        self.assertEqual(parse_retry_after("Wed, 21 Oct 2026 07:28:30 GMT", now), 30.0)
        with self.assertRaises(ValueError):
            parse_retry_after("soon", now)
