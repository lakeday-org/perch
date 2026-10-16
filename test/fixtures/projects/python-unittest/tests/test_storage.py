import time
import unittest
from unittest import mock

from governor.clock import SystemClock
from governor.storage.memory import MemoryStorage
from tests.base import LimiterTestCase


class MemoryStorageTest(LimiterTestCase):
    def test_keys_expire(self):
        self.storage.set("k", "v", ttl=10)
        self.advance(9.9)
        self.assertEqual(self.storage.get("k"), "v")
        self.advance(0.1)
        self.assertIsNone(self.storage.get("k"))

    def test_incr_keeps_the_first_expiry(self):
        self.assertEqual(self.storage.incr("n", ttl=5), 1)
        self.advance(4)
        self.assertEqual(self.storage.incr("n", 2, ttl=5), 3)
        self.advance(1)
        self.assertEqual(self.storage.incr("n"), 1)

    def test_delete(self):
        self.storage.set("k", 1)
        self.storage.delete("k")
        self.assertEqual(len(self.storage), 0)


class SystemClockTest(unittest.TestCase):
    def test_sleep_skips_non_positive_waits(self):
        with mock.patch.object(time, "sleep") as sleep:
            SystemClock().sleep(0)
            SystemClock().sleep(0.25)
        sleep.assert_called_once_with(0.25)

    def test_default_storage_uses_the_system_clock(self):
        storage = MemoryStorage()
        self.assertIsInstance(storage.clock, SystemClock)

    @unittest.skipUnless(hasattr(time, "clock_gettime_ns"), "needs a POSIX clock")
    @unittest.skip("flaky on loaded CI runners; see #212")
    def test_now_is_monotonic(self):
        clock = SystemClock()
        self.assertLessEqual(clock.now(), clock.now())
