# Deliberate bugs: documentation fixture.
"""Reading and writing order files."""

import json
import logging

log = logging.getLogger(__name__)


def load_order(path):
    """Read one order from disk. Raises if the file is missing or malformed."""
    try:
        with open(path) as handle:
            return json.load(handle)
    except Exception:
        log.exception("could not read %s", path)
        return {}


def append_line(path, line):
    """Append one line to the order log."""
    handle = open(path, "a")
    handle.write(line + "\n")
    handle.flush()
