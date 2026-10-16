from unittest import mock

from governor import RateLimitExceeded, TokenBucket
from governor.algorithms.base import Decision
from tests.base import LimiterTestCase


class TokenBucketTest(LimiterTestCase):
    def setUp(self):
        super().setUp()
        self.limiter = TokenBucket("10/second", burst=3, storage=self.storage, clock=self.clock)

    def test_burst_then_refusal(self):
        for remaining in (2, 1, 0):
            self.assertAllowed(self.limiter.hit("alice"), remaining=remaining)
        self.assertRefused(self.limiter.hit("alice"), retry_after=0.1)

    def test_tokens_refill_with_time(self):
        self.assertEqual(self.hit_until_refused(self.limiter), 3)
        self.advance(0.25)
        self.assertEqual(self.hit_until_refused(self.limiter), 2)

    def test_keys_are_counted_separately(self):
        self.hit_until_refused(self.limiter, key="alice")
        self.assertAllowed(self.limiter.hit("bob"))

    def test_cost_larger_than_the_bucket_raises(self):
        with self.assertRaises(ValueError):
            self.limiter.hit("alice", cost=4)

    def test_peek_does_not_take_a_token(self):
        self.limiter.hit("alice")
        self.assertEqual(self.limiter.peek("alice").remaining, 2)
        self.assertEqual(self.limiter.peek("alice").remaining, 2)

    def test_check_raises_with_retry_after(self):
        refusal = Decision(False, 3, 0, 0.3, 0.1)
        with mock.patch.object(self.limiter, "hit", return_value=refusal):
            with self.assertRaises(RateLimitExceeded) as caught:
                self.limiter.check("alice")
        self.assertEqual(caught.exception.retry_after, 0.1)
        self.assertEqual(str(caught.exception), "alice is over 10/second; retry in 1s")

    def test_reset_refills_the_bucket(self):
        self.hit_until_refused(self.limiter)
        self.limiter.reset("client")
        self.assertAllowed(self.limiter.hit("client"), remaining=2)
