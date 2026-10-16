"""Functions that say whose request a WSGI environ is, which is what a limit is counted against."""
import ipaddress
from typing import Callable, Iterable

KeyFunc = Callable[[dict], str]


def remote_addr(environ: dict, trusted_proxies: Iterable[str] = ()) -> str:
    """The client address, read through X-Forwarded-For only as far back as the proxies we trust."""
    addr = environ.get("REMOTE_ADDR", "")
    forwarded = environ.get("HTTP_X_FORWARDED_FOR")
    if not forwarded or not _trusted(addr, trusted_proxies):
        return addr or "unknown"
    hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
    for hop in reversed(hops):
        if not _trusted(hop, trusted_proxies):
            return hop
    return hops[0] if hops else addr


def _trusted(addr: str, proxies: Iterable[str]) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return any(ip in ipaddress.ip_network(proxy, strict=False) for proxy in proxies)


def header(name: str, default: str = "anonymous") -> KeyFunc:
    """A key read from a request header, such as an API key."""
    field = "HTTP_" + name.upper().replace("-", "_")

    def key(environ: dict) -> str:
        return environ.get(field) or default

    return key


def compose(*funcs: KeyFunc, separator: str = "|") -> KeyFunc:
    if not funcs:
        raise ValueError("compose needs at least one key function")

    def key(environ: dict) -> str:
        return separator.join(func(environ) for func in funcs)

    return key
