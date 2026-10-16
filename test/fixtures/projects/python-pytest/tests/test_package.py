import tally


def test_open_ledger_has_the_small_business_chart():
    books = tally.open_ledger()
    assert books.account("1200").name == "Accounts receivable"
    assert len(books) == 0


def test_public_names_are_exported():
    for name in tally.__all__:
        assert hasattr(tally, name), name


def test_version_matches_the_package_metadata():
    assert tally.__version__ == "0.4.2"
