from unittest import mock

import governor
from governor.algorithms.token_bucket import TokenBucket
from tests.base import LimiterTestCase


class LimitDecoratorTest(LimiterTestCase):
    def setUp(self):
        super().setUp()
        self.bucket = TokenBucket("1/second", storage=self.storage, clock=self.clock)
        self.calls = []

    def search(self, user):
        self.calls.append(user)
        return f"results for {user}"

    def test_raises_once_the_limit_is_spent(self):
        search = governor.limit(self.bucket, key=lambda user: user)(self.search)
        self.assertEqual(search("ann"), "results for ann")
        with self.assertRaises(governor.RateLimitExceeded):
            search("ann")
        self.assertEqual(self.calls, ["ann"])

    def test_block_waits_its_turn(self):
        search = governor.limit(self.bucket, block=True)(self.search)
        search("ann")
        search("bob")
        self.assertEqual(self.clock.slept, [1.0])
        self.assertEqual(self.calls, ["ann", "bob"])

    def test_block_gives_up_after_max_wait(self):
        search = governor.limit(self.bucket, block=True, max_wait=0.5)(self.search)
        search("ann")
        with mock.patch.object(self.clock, "sleep") as sleep:
            with self.assertRaises(governor.RateLimitExceeded):
                search("bob")
        sleep.assert_not_called()
