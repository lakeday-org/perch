"""What every limiter test starts from: a clock that only moves when told to, and storage on that clock."""
import unittest

from governor.storage.memory import MemoryStorage
from governor.testing import FakeClock


class LimiterTestCase(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.storage = MemoryStorage(self.clock)

    def advance(self, seconds):
        self.clock.advance(seconds)

    def hit_until_refused(self, limiter, key="client", most=1000):
        """How many hits the limiter allows before its first refusal."""
        for count in range(most):
            if not limiter.hit(key).allowed:
                return count
        self.fail(f"{limiter.name} never refused {most} hits")

    def assertAllowed(self, decision, remaining=None):
        self.assertTrue(decision.allowed, f"refused: {decision}")
        if remaining is not None:
            self.assertEqual(decision.remaining, remaining)

    def assertRefused(self, decision, retry_after=None):
        self.assertFalse(decision.allowed, f"allowed: {decision}")
        if retry_after is not None:
            self.assertAlmostEqual(decision.retry_after, retry_after, places=6)
