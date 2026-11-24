"""Reading the installed game: DS1 round trip, collision, animated characters and the export check.
Skipped without the game (these need CASC access through server.py)."""
import json
import pathlib
import struct
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT))
try:
    import casc
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


if __name__ == "__main__":
    unittest.main()
