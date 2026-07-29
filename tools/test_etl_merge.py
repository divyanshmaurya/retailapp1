#!/usr/bin/env python3
"""
Tests for the incremental merge in etl_sap_export.

Run with:  python3 -m unittest discover -s tools -p 'test_*.py'

The merge is small but it is the piece that decides whether re-ingesting an
export corrects the existing rows or silently doubles them, so it is worth
pinning down. The dtype case below is not hypothetical: a fresh extract types
hourStart as datetime64 while the same column read back from CSV is a string,
and until that was normalised no key ever matched, so every re-ingested hour was
appended rather than superseded.
"""

import unittest

import pandas as pd

from etl_sap_export import merge_on_key

KEYS = ["articleName", "hourStart"]


def frame(rows):
    return pd.DataFrame(rows, columns=["articleName", "hourStart", "quantity"])


class MergeOnKey(unittest.TestCase):
    def test_first_run_takes_everything(self):
        incoming = frame([["Cola", "2026-01-01 12:00:00", 3]])
        merged, superseded = merge_on_key(None, incoming, KEYS)
        self.assertEqual(len(merged), 1)
        self.assertEqual(superseded, 0)

    def test_new_hours_are_added(self):
        existing = frame([["Cola", "2026-01-01 12:00:00", 3]])
        incoming = frame([["Cola", "2026-01-02 12:00:00", 5]])
        merged, superseded = merge_on_key(existing, incoming, KEYS)
        self.assertEqual(len(merged), 2)
        self.assertEqual(superseded, 0)

    def test_a_repeated_hour_is_corrected_not_duplicated(self):
        existing = frame([["Cola", "2026-01-01 12:00:00", 3]])
        incoming = frame([["Cola", "2026-01-01 12:00:00", 4]])
        merged, superseded = merge_on_key(existing, incoming, KEYS)
        self.assertEqual(len(merged), 1)
        self.assertEqual(superseded, 1)
        # The later export wins: a re-export of an hour is a correction.
        self.assertEqual(int(merged.iloc[0]["quantity"]), 4)

    def test_a_datetime_key_matches_the_same_key_read_back_from_csv(self):
        # Exactly the shape the real pipeline hits, and the reason the merge
        # needs to normalise its key columns before comparing them.
        existing = frame([["Cola", "2026-01-01 12:00:00", 3]])
        incoming = frame([["Cola", pd.Timestamp("2026-01-01 12:00:00"), 4]])
        merged, superseded = merge_on_key(existing, incoming, KEYS)
        self.assertEqual(len(merged), 1, "a datetime key must match its string form")
        self.assertEqual(superseded, 1)
        self.assertEqual(int(merged.iloc[0]["quantity"]), 4)

    def test_merging_is_idempotent(self):
        existing = frame([
            ["Cola", "2026-01-01 12:00:00", 3],
            ["Water", "2026-01-01 12:00:00", 1],
        ])
        once, _ = merge_on_key(existing, existing.copy(), KEYS)
        twice, _ = merge_on_key(once, existing.copy(), KEYS)
        self.assertEqual(len(once), 2)
        self.assertEqual(len(twice), 2)
        pd.testing.assert_frame_equal(once, twice)

    def test_output_order_does_not_depend_on_which_export_arrived_first(self):
        a = frame([["Water", "2026-01-02 12:00:00", 1]])
        b = frame([["Cola", "2026-01-01 12:00:00", 3]])
        forwards, _ = merge_on_key(a, b, KEYS)
        backwards, _ = merge_on_key(b, a, KEYS)
        pd.testing.assert_frame_equal(forwards, backwards)

    def test_a_column_added_by_a_later_export_is_kept(self):
        existing = frame([["Cola", "2026-01-01 12:00:00", 3]])
        incoming = frame([["Cola", "2026-01-02 12:00:00", 5]])
        incoming["netRevenue"] = 4.20
        merged, _ = merge_on_key(existing, incoming, KEYS)
        self.assertIn("netRevenue", merged.columns)
        self.assertEqual(len(merged), 2)


if __name__ == "__main__":
    unittest.main()
