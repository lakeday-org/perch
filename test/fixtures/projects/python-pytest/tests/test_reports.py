from datetime import date

import pytest

from tally.reports import aging_bucket, aging_report


@pytest.mark.parametrize(("days", "bucket"), [(0, "current"), (1, "1-30"), (30, "1-30"), (61, "61-90"), (91, "90+")])
def test_aging_bucket(days, bucket):
    assert aging_bucket(days) == bucket


def test_aging_report_buckets_what_is_owed(consulting_invoice, numberer):
    consulting_invoice.issue(numberer, date(2026, 1, 1))
    report = aging_report([consulting_invoice], today=date(2026, 3, 15))
    assert report["31-60"].amount > 0
    assert report["current"].is_zero()
