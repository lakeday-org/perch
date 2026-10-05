import unittest

from governor import keys


def environ(addr="203.0.113.9", forwarded=None, **headers):
    env = {"REMOTE_ADDR": addr, "PATH_INFO": "/search"}
    if forwarded is not None:
        env["HTTP_X_FORWARDED_FOR"] = forwarded
    for name, value in headers.items():
        env["HTTP_" + name.upper()] = value
    return env


class RemoteAddrTest(unittest.TestCase):
    def test_untrusted_peer_is_the_client(self):
        self.assertEqual(keys.remote_addr(environ(forwarded="1.2.3.4")), "203.0.113.9")

    def test_reads_through_trusted_proxies(self):
        env = environ(addr="10.0.0.2", forwarded="198.51.100.7, 10.0.0.5")
        self.assertEqual(keys.remote_addr(env, trusted_proxies=["10.0.0.0/8"]), "198.51.100.7")

    def test_cases(self):
        cases = [
            (environ(addr=""), [], "unknown"),
            (environ(addr="10.0.0.2", forwarded="10.0.0.3"), ["10.0.0.0/8"], "10.0.0.3"),
            (environ(addr="10.0.0.2", forwarded="not-an-ip, 10.0.0.3"), ["10.0.0.0/8"], "not-an-ip"),
        ]
        for env, proxies, expected in cases:
            with self.subTest(env=env, proxies=proxies):
                self.assertEqual(keys.remote_addr(env, proxies), expected)


class KeyFunctionsTest(unittest.TestCase):
    def test_header_falls_back_to_a_default(self):
        api_key = keys.header("X-Api-Key")
        self.assertEqual(api_key(environ(x_api_key="k_123")), "k_123")
        self.assertEqual(api_key(environ()), "anonymous")

    def test_compose_joins_keys(self):
        key = keys.compose(keys.remote_addr, keys.header("X-Api-Key"))
        self.assertEqual(key(environ(x_api_key="k_1")), "203.0.113.9|k_1")

    def test_compose_needs_a_function(self):
        with self.assertRaises(ValueError):
            keys.compose()
