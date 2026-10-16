import unittest

from governor.policy import Rate, parse_policy, parse_rate


class ParseRateTest(unittest.TestCase):
    def test_forms_people_write(self):
        cases = {
            "100/minute": Rate(100, 60),
            "10 per second": Rate(10, 1),
            "1000/6 hours": Rate(1000, 21600),
            "5/min": Rate(5, 60),
            "  3 / day ": Rate(3, 86400),
            "20 per h": Rate(20, 3600),
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(parse_rate(text), expected)

    def test_rejects_what_it_cannot_read(self):
        for text in ["", "fast", "100", "100/fortnight", "-1/second"]:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    parse_rate(text)

    def test_zero_is_not_a_rate(self):
        with self.assertRaises(ValueError):
            Rate(0, 60)


class RateTest(unittest.TestCase):
    def test_str_round_trips(self):
        for text in ["100/minute", "1000/6 hours", "7/day", "2/second"]:
            with self.subTest(text=text):
                self.assertEqual(str(parse_rate(text)), text)

    def test_per_second(self):
        self.assertAlmostEqual(parse_rate("120/minute").per_second, 2.0)


class ParsePolicyTest(unittest.TestCase):
    def test_sorted_shortest_period_first_without_duplicates(self):
        rates = parse_policy("500/hour; 10/second, 10/second;")
        self.assertEqual(rates, [Rate(10, 1), Rate(500, 3600)])

    def test_empty_policy_raises(self):
        with self.assertRaises(ValueError):
            parse_policy(" ; ")
