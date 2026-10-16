"""Shims for the oldest Python tally supports. Measured on every interpreter in CI, so left out of coverage."""
import sys

if sys.version_info >= (3, 11):
    from datetime import UTC
else:  # pragma: no cover
    from datetime import timezone

    UTC = timezone.utc


def removeprefix(text: str, prefix: str) -> str:
    if hasattr(text, "removeprefix"):
        return text.removeprefix(prefix)
    if text.startswith(prefix):
        return text[len(prefix):]
    return text
