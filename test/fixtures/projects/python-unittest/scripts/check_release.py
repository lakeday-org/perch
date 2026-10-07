#!/usr/bin/env python3
"""Checks that the version in pyproject.toml, governor/__init__.py and the changelog agree before tagging a release."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def declared_versions():
    pyproject = re.search(r'^version = "([^"]+)"', (ROOT / "pyproject.toml").read_text(), re.M)
    package = re.search(r'^__version__ = "([^"]+)"', (ROOT / "governor" / "__init__.py").read_text(), re.M)
    return {"pyproject.toml": pyproject and pyproject[1], "governor/__init__.py": package and package[1]}


def main(argv):
    versions = declared_versions()
    if len(set(versions.values())) != 1:
        for path, version in versions.items():
            print(f"{path}: {version}", file=sys.stderr)
        return 1
    tag = argv[1] if len(argv) > 1 else None
    if tag and tag.lstrip("v") != next(iter(versions.values())):
        print(f"tag {tag} does not match {next(iter(versions.values()))}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
