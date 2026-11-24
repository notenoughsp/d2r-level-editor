"""Reading the installed game: DS1 round trip, collision, animated characters, the export check and
project files. Skipped without the game (these need CASC access through server.py).
The editor data folder is a temporary one, so the tests never touch the real projects."""
import importlib
import io
import json
import os
import pathlib
import struct
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT))
TMP = tempfile.TemporaryDirectory()
try:
    import casc
    os.environ["D2R_GAME"] = casc.GAME  # found with the real settings, then a fresh data folder
    os.environ["D2R_EDITOR_DATA"] = TMP.name
    casc = importlib.reload(casc)
    HAVE_GAME = casc.is_game_dir(casc.GAME)
except Exception:  # noqa: BLE001
    HAVE_GAME = False


@unittest.skipUnless(HAVE_GAME, "Diablo II: Resurrected not found")
class GameData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import server  # noqa: PLC0415 (opens the game storage)
        cls.server = server

    def test_ds1_round_trip(self):
        from ds1 import DS1  # noqa: PLC0415
        raw = self.server.read_asset("data/global/tiles/act1/town/townn1.ds1", original=True)
        self.assertEqual(DS1(raw).to_bytes(), raw)

    def test_collision_block_and_reset(self):
        import collision  # noqa: PLC0415
        from ds1 import DS1  # noqa: PLC0415
        path = "data/global/tiles/act1/town/townn1.ds1"
        d = DS1(self.server.read_asset(path, original=True))
        d.original = DS1(self.server.read_asset(path, original=True))
        table = collision.tile_table(self.server.read_asset, d)
        collision.apply_ops(d, [{"tx": 20, "ty": 20, "mode": "block"}])
        self.assertTrue((collision.compute(d, table)[100:105, 100:105] & 1).all())
        collision.apply_ops(d, [{"tx": 20, "ty": 20, "mode": "reset"}])
        self.assertEqual(d.to_bytes(), d.original.to_bytes())

    def test_character_glb_has_skin_and_animations(self):
        data = self.server.character_glb("charsi")
        n = struct.unpack_from("<I", data, 12)[0]
        j = json.loads(data[20:20 + n])
        self.assertIn("neutral", j["extras"]["animations"])
        self.assertEqual(len(j["skins"]), 1)

    def test_check_runs(self):
        self.assertIn("problems", self.server.project_check())

    def test_request_paths_and_names_are_checked(self):
        s = self.server
        self.assertEqual(s.preset_key("Data\\HD\\env\\preset\\act1\\town\\townn1.json"), "data/hd/env/preset/act1/town/townn1.json")
        for bad in ("c:\\x", "data/hd/env/preset/../../x.json", "data/hd/env/preset/a.json:ads", "data/global/x.json"):
            with self.assertRaises(ValueError, msg=bad):
                s.preset_key(bad)
        for name in ("CON", "nul", "com1", "LPT9.x"):
            self.assertTrue(s.reserved_name(name), name)
            with self.assertRaises(ValueError):
                s.kit_file(name)
        self.assertFalse(s.reserved_name("console"))

    def test_export_never_replaces_another_mod(self):
        mods = pathlib.Path(TMP.name) / "mods"
        ok = self.server.export_target_ok
        self.assertTrue(ok(mods / "New"))
        (mods / "Empty").mkdir(parents=True)
        self.assertTrue(ok(mods / "Empty"))
        (mods / "Other" / "Other.mpq").mkdir(parents=True)
        self.assertFalse(ok(mods / "Other"))
        (mods / "Mine").mkdir()
        (mods / "Mine" / self.server.EXPORT_MARK).write_text("{}")
        self.assertTrue(ok(mods / "Mine"))
        (mods / "Old" / "d2rloader" / "plugins").mkdir(parents=True)
        (mods / "Old" / "d2rloader" / "plugins" / "d2r-fixed-seed.dll").write_bytes(b"")
        self.assertTrue(ok(mods / "Old"))

    def test_project_import_stays_in_its_folder(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("d2r-editor-project.json", "{}")
            z.writestr("project/data/ok.txt", "ok")
            z.writestr(r"project/a\..\..\..\escaped.txt", "bad")
            z.writestr("project/../escaped2.txt", "bad")
        self.server.project_import(buf.getvalue(), "Imported")
        data = pathlib.Path(TMP.name)
        self.assertEqual([p.name for p in data.rglob("escaped*")], [])
        self.assertTrue((data / "project/data/ok.txt").exists())
        self.server.switch_project("Default")
        with self.assertRaises(ValueError):
            self.server.project_import(buf.getvalue(), "imported")  # same folder name on Windows


if __name__ == "__main__":
    unittest.main()
