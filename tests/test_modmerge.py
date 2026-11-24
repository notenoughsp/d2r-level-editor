"""Merging two exported mods (tools/modmerge.py) on hand-made mod folders."""
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "tools"))
import modmerge  # noqa: E402

ORIG = b"Name\tId\tX\r\nA\t0\t1\r\nB\t1\t2\r\nC\t2\t3\r\n"


def make_mod(root, name, table=None, files=None):
    mpq = root / name / f"{name}.mpq"
    if table is not None:
        (mpq / "data/global/excel").mkdir(parents=True)
        (mpq / "data/global/excel/levels.txt").write_bytes(table)
    for rel, data in (files or {}).items():
        p = mpq / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return root / name


class Merge(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_tables_merge_row_by_row(self):
        a = make_mod(self.root, "A", ORIG.replace(b"A\t0\t1", b"A\t0\t9") + b"NA\t3\t5\r\n", {"data/hd/a.json": b"1"})
        b = make_mod(self.root, "B", ORIG.replace(b"B\t1\t2", b"B\t1\t7") + b"NB\t4\t6\r\n", {"data/hd/b.json": b"2"})
        self.assertEqual([c["kind"] for c in modmerge.conflicts(a, b)["conflicts"]], ["table"])
        r = modmerge.merge(a, b, self.root / "AB", lambda p: ORIG)
        self.assertEqual(r["clashes"], [])
        out = (self.root / "AB/AB.mpq/data/global/excel/levels.txt").read_bytes()
        self.assertEqual(out, b"Name\tId\tX\r\nA\t0\t9\r\nB\t1\t7\r\nC\t2\t3\r\nNA\t3\t5\r\nNB\t4\t6\r\n")
        self.assertTrue((self.root / "AB/AB.mpq/data/hd/a.json").exists())
        self.assertTrue((self.root / "AB/AB.mpq/data/hd/b.json").exists())

    def test_same_row_changed_twice_clashes(self):
        a = make_mod(self.root, "A", ORIG.replace(b"A\t0\t1", b"A\t0\t8"))
        b = make_mod(self.root, "B", ORIG.replace(b"A\t0\t1", b"A\t0\t9"))
        r = modmerge.merge(a, b, self.root / "AB", lambda p: ORIG)
        self.assertTrue(r["clashes"])
        self.assertFalse((self.root / "AB").exists())  # nothing written
        modmerge.merge(a, b, self.root / "AB2", lambda p: ORIG, b_wins=True)
        self.assertIn(b"A\t0\t9", (self.root / "AB2/AB2.mpq/data/global/excel/levels.txt").read_bytes())

    def test_strings_merge_by_key(self):
        orig = json.dumps([{"id": 1, "Key": "x", "enUS": "X"}]).encode("utf-8-sig")
        sa = json.dumps([{"id": 1, "Key": "x", "enUS": "X"}, {"id": 5, "Key": "a", "enUS": "A"}]).encode("utf-8-sig")
        sb = json.dumps([{"id": 1, "Key": "x", "enUS": "Y"}, {"id": 6, "Key": "b", "enUS": "B"}]).encode("utf-8-sig")
        data, clashes, _ = modmerge.merge_strings(orig, sa, sb, False)
        keys = {e["Key"]: e["enUS"] for e in json.loads(data.decode("utf-8-sig"))}
        self.assertEqual(keys, {"x": "Y", "a": "A", "b": "B"})
        self.assertEqual(clashes, [])


if __name__ == "__main__":
    unittest.main()
