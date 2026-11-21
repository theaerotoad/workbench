import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from state_store import StateStore


class TestStateStore(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = os.path.join(self.temp_dir.name, "wb_state")
        self.store = StateStore(self.data_dir)

    def tearDown(self):
        try:
            self.store.close()
        except Exception:
            pass
        self.temp_dir.cleanup()

    def test_init_creates_db_and_persists_server_id(self):
        self.assertTrue(os.path.exists(os.path.join(self.data_dir, "workbench_state.sqlite3")))
        self.assertTrue(os.path.exists(os.path.join(self.data_dir, "server_id")))
        first_id = self.store.server_id
        self.assertTrue(len(first_id) >= 32)

        conn = sqlite3.connect(self.store.db_path)
        try:
            user_version = conn.execute("PRAGMA user_version;").fetchone()[0]
            journal_mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(user_version, 1)
        self.assertEqual(journal_mode.lower(), "wal")

        self.store.close()
        reopened = StateStore(self.data_dir)
        self.store = reopened
        self.assertEqual(reopened.server_id, first_id)

    def test_put_get_and_optimistic_concurrency(self):
        self.assertIsNone(self.store.get("sessions", "k1"))

        ok, rev = self.store.put("sessions", "k1", b'{"a":1}', base_rev=0, client_id="c1")
        self.assertTrue(ok)
        self.assertEqual(rev, 1)

        rec = self.store.get("sessions", "k1")
        self.assertIsNotNone(rec)
        self.assertEqual(rec["rev"], 1)
        self.assertFalse(rec["deleted"])
        self.assertEqual(rec["value"], b'{"a":1}')

        # Wrong base_rev fails and reports current rev
        ok2, cur = self.store.put("sessions", "k1", b'{"a":2}', base_rev=0)
        self.assertFalse(ok2)
        self.assertEqual(cur, 1)

        ok3, cur3 = self.store.put("sessions", "k1", b'{"a":2}', base_rev=5)
        self.assertFalse(ok3)
        self.assertEqual(cur3, 1)

        # Correct base_rev increments rev
        ok4, rev4 = self.store.put("sessions", "k1", b'{"a":2}', base_rev=1)
        self.assertTrue(ok4)
        self.assertEqual(rev4, 2)
        self.assertEqual(self.store.get("sessions", "k1")["value"], b'{"a":2}')

        # Unconditional put (base_rev=None) succeeds regardless of current rev
        ok5, rev5 = self.store.put("sessions", "k1", b'{"a":3}', base_rev=None)
        self.assertTrue(ok5)
        self.assertEqual(rev5, 3)

    def test_delete_tombstone_and_resurrection(self):
        # Deleting a missing key creates a tombstone at rev 1
        ok, rev = self.store.delete("sessions", "missing", base_rev=0)
        self.assertTrue(ok)
        self.assertEqual(rev, 1)
        rec = self.store.get("sessions", "missing")
        self.assertTrue(rec["deleted"])
        self.assertIsNone(rec["value"])
        self.assertEqual(rec["rev"], 1)

        # Writing over a tombstone with base_rev=0 must fail (rev is 1)
        ok_bad, cur = self.store.put("sessions", "missing", b"{}", base_rev=0)
        self.assertFalse(ok_bad)
        self.assertEqual(cur, 1)

        # Writing over a tombstone with matching base_rev succeeds
        ok_good, rev2 = self.store.put("sessions", "missing", b'{"alive":true}', base_rev=1)
        self.assertTrue(ok_good)
        self.assertEqual(rev2, 2)
        rec2 = self.store.get("sessions", "missing")
        self.assertFalse(rec2["deleted"])
        self.assertEqual(rec2["value"], b'{"alive":true}')

        # Deleting an existing key clears value and bumps rev
        ok_del, rev3 = self.store.delete("sessions", "missing", base_rev=2)
        self.assertTrue(ok_del)
        self.assertEqual(rev3, 3)
        rec3 = self.store.get("sessions", "missing")
        self.assertTrue(rec3["deleted"])
        self.assertIsNone(rec3["value"])

    def test_list_prefix_exact_and_special_characters(self):
        keys = [
            "a::one",
            "a::two",
            "a:b",
            "a%wild",
            "a_under",
            "dir/sub/with spaces/café 日本語",
        ]
        for k in keys:
            ok, _ = self.store.put("sessions", k, b"123", base_rev=0)
            self.assertTrue(ok)
        # Put an item in a different store with same prefix to verify store isolation
        self.store.put("baselines", "a::one", b"999", base_rev=0)

        # Tombstone one item to ensure list includes deleted=True
        self.store.delete("sessions", "a::two", base_rev=1)

        items = self.store.list("sessions", prefix="a::")
        self.assertEqual([i["key"] for i in items], ["a::one", "a::two"])
        self.assertFalse(items[0]["deleted"])
        self.assertEqual(items[0]["size"], 3)
        self.assertTrue(items[1]["deleted"])
        self.assertEqual(items[1]["size"], 0)

        # SQL LIKE wildcards (% and _) must be treated literally
        pct_items = self.store.list("sessions", prefix="a%")
        self.assertEqual([i["key"] for i in pct_items], ["a%wild"])
        under_items = self.store.list("sessions", prefix="a_")
        self.assertEqual([i["key"] for i in under_items], ["a_under"])

        # Unicode / slash / space key round trip
        uni_items = self.store.list("sessions", prefix="dir/sub/")
        self.assertEqual([i["key"] for i in uni_items], ["dir/sub/with spaces/café 日本語"])

    def test_delete_prefix(self):
        self.store.put("sessions", "ws1::index", b"1", base_rev=0)
        self.store.put("sessions", "ws1::session::1", b"2", base_rev=0)
        self.store.put("sessions", "ws2::index", b"3", base_rev=0)

        deleted_count = self.store.delete_prefix("sessions", "ws1::", client_id="c1")
        self.assertEqual(deleted_count, 2)

        # Calling again deletes 0 (already tombstoned)
        self.assertEqual(self.store.delete_prefix("sessions", "ws1::"), 0)

        self.assertTrue(self.store.get("sessions", "ws1::index")["deleted"])
        self.assertEqual(self.store.get("sessions", "ws1::index")["rev"], 2)
        self.assertFalse(self.store.get("sessions", "ws2::index")["deleted"])


if __name__ == "__main__":
    unittest.main()