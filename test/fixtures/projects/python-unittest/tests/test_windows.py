from governor.algorithms.fixed_window import FixedWindow
from governor.algorithms.sliding_window import SlidingWindowCounter
from tests.base import LimiterTestCase


class FixedWindowTest(LimiterTestCase):
    def setUp(self):
        super().setUp()
        self.limiter = FixedWindow("5/minute", storage=self.storage, clock=self.clock)

    def test_allows_the_limit_in_one_window(self):
        self.assertEqual(self.hit_until_refused(self.limiter), 5)

    def test_next_window_starts_fresh(self):
        self.hit_until_refused(self.limiter)
        self.advance(self.limiter.hit("client").reset_after)
        self.assertAllowed(self.limiter.hit("client"), remaining=4)

    def test_refused_hits_take_nothing(self):
        self.hit_until_refused(self.limiter)
        for _ in range(3):
            self.limiter.hit("client")
        self.assertEqual(self.limiter.peek("client").remaining, 0)
        self.assertEqual(self.storage.get(f"{self.limiter.key_for('client')}:999960"), 5)


class SlidingWindowCounterTest(LimiterTestCase):
    def setUp(self):
        super().setUp()
        self.limiter = SlidingWindowCounter("10/minute", storage=self.storage, clock=self.clock)

    def test_previous_window_still_counts(self):
        self.advance(60 - self.clock.now() % 60)
        self.assertEqual(self.hit_until_refused(self.limiter), 10)
        self.advance(75)
        decision = self.limiter.hit("client")
        self.assertAllowed(decision)
        self.assertEqual(decision.remaining, 1)

    def test_refusal_says_when_to_retry(self):
        self.hit_until_refused(self.limiter)
        decision = self.limiter.hit("client")
        self.assertRefused(decision)
        self.assertGreater(decision.retry_after, 0)
        self.assertLessEqual(decision.retry_after, 60)
