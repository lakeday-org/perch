"""Sphinx configuration for tally's documentation."""
import os
import sys

sys.path.insert(0, os.path.abspath("../src"))

project = "tally"
author = "The tally authors"
extensions = ["sphinx.ext.autodoc", "sphinx.ext.napoleon", "sphinx.ext.intersphinx"]
intersphinx_mapping = {"python": ("https://docs.python.org/3", None)}
html_theme = "furo"


def setup(app):
    app.add_css_file("tally.css")


def linkcode_resolve(domain, info):
    if domain != "py" or not info["module"]:
        return None
    path = info["module"].replace(".", "/")
    return f"https://github.com/tally-books/tally/blob/main/src/{path}.py"
