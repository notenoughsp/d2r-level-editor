"""Gameplay collision of a DS1 preset, and editing it with invisible blocking tiles.

Collision per subtile = OR of the 5x5 subtile flags of every floor and wall tile in the cell
(tiles looked up by (orientation, main, sub) in the preset's DT1 files plus the tile sets the
game loads for every level: Act1\\Outdoors\\Blank.dt1, Act1\\Barracks\\InvisWal.dt1,
Act1\\Barracks\\Warp.dt1).

Blocking: Blank.dt1 tile (orientation 0, main 30) is invisible and blocks the whole tile:
  sub 1 -> flags 0x01 (walking), sub 0 -> flags 0x05 (walking + jump/teleport).
The editor puts it into an extra floor layer so the original tiles stay untouched.
Clearing a tile removes its wall tiles (all wall layers) and our blocking tile.

Coordinates: 1 tile = 5 subtiles = 10 HD units; HD x -> DS1 x, HD z -> DS1 y.
"""
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ds1 import encode_cell  # noqa: E402
from dt1 import DT1  # noqa: E402

ALWAYS_LOADED = ["data/global/tiles/act1/outdoors/blank.dt1",
                 "data/global/tiles/act1/barracks/inviswal.dt1",
                 "data/global/tiles/act1/barracks/warp.dt1"]
BLOCK_MAIN = 30
BLOCK_SUB = {"block": 1, "blockall": 0}

# Subtile collision (experimental, not offered in the editor): invisible tiles with any 5x5
# pattern, added to the project's copy of Blank.dt1 (loaded for every level). Test of 2026-11-22:
# the game reads Blank.dt1 from the mod (changed flags of existing tiles work), but tiles added
# to the file come out fully blocked whatever their flags, so new patterns cannot be made this way. Main indices 43 and 44 (orientation 0) are used by no
# floor tile of the game, so they cannot clash: 128 patterns per project.
BLANK_DT1 = "data/global/tiles/act1/outdoors/blank.dt1"
CUSTOM_MAINS = (44, 43)
SUBTILE_FLAG = {"sub_block": 0x01, "sub_blockall": 0x05}


def flag_index(x, y):
    """Index in the 25 subtile flags of subtile (x, y) inside a tile (ORDER flipy)."""
    return (4 - y) * 5 + x


class SubtileTiles:
    """The project's subtile patterns: (main, sub) <-> 25 flag bytes, stored in Blank.dt1."""

    def __init__(self, read_asset, write_asset):
        self.read_asset, self.write_asset = read_asset, write_asset
        self.raw = read_asset(BLANK_DT1)
        self.by_key = {(t["main"], t["sub"]): t["flags"] for t in DT1(self.raw).tiles
                       if t["orientation"] == 0 and t["main"] in CUSTOM_MAINS}
        self.by_flags = {f: k for k, f in self.by_key.items()}

    def key_for(self, flags):
        flags = bytes(flags)
        if flags in self.by_flags:
            return self.by_flags[flags]
        free = [(m, s) for m in CUSTOM_MAINS for s in range(64) if (m, s) not in self.by_key]
        if not free:
            raise ValueError("All 128 subtile patterns are in use.")
        key = free[0]
        from dt1 import add_tiles  # noqa: PLC0415
        self.raw = add_tiles(self.raw, 0, [(0, key[0], key[1], flags)])
        self.write_asset(BLANK_DT1, self.raw)
        self.by_key[key] = flags
        self.by_flags[flags] = key
        return key

# Subtile flag index -> (x, y) inside the tile: x = i % 5, y = 4 - i // 5 ("flipy").
# Chosen with verify_order() on the act 1 town: it yields continuous walls and corners and
# puts the most HD palisade pieces on blocked subtiles (26/40 vs 16/40 for row order).
ORDER = "flipy"


def tile_paths(ds1):
    out = []
    for f in ds1.files:
        p = f.replace("\\", "/").lower()
        p = p[p.index("data/"):] if "data/" in p else p
        if p.endswith(".tg1"):  # many DS1 files list their tile sets as .tg1; the game reads the .dt1
            p = p[:-4] + ".dt1"
        if p.endswith(".dt1") and p not in out:
            out.append(p)
    return out + [p for p in ALWAYS_LOADED if p not in out]


def tile_table(read_asset, ds1):
    table = {}
    for p in tile_paths(ds1):
        try:
            for k, t in DT1(read_asset(p)).by_key().items():
                table.setdefault(k, t["flags"])
        except (FileNotFoundError, ValueError):
            continue
    return table


def subtile_xy(order):
    idx = np.arange(25)
    x, y = idx % 5, idx // 5
    if order in ("flipx", "flipxy"):
        x = 4 - x
    if order in ("flipy", "flipxy"):
        y = 4 - y
    return x, y


def compute(ds1, table, order=None):
    order = order or ORDER or "normal"
    sx, sy = subtile_xy(order)
    grid = np.zeros((ds1.height * 5, ds1.width * 5), dtype=np.uint8)
    cells = []
    for i in range(ds1.floor_layers):
        cells.append((ds1.layers[("floor", i)], None))
    for i in range(ds1.wall_layers):
        cells.append((ds1.layers[("wall", i)], ds1.layers[("orient", i)]))
    for layer, orient in cells:
        for n, v in enumerate(layer):
            if not v or (v & 0xFF) == 0 or v >> 31:
                continue
            o = (orient[n] & 0xFF) if orient else 0
            flags = table.get((o, (v >> 20) & 0x3F, (v >> 8) & 0x3F))
            if not flags:
                continue
            ty, tx = divmod(n, ds1.width)
            f = np.frombuffer(flags, dtype=np.uint8)
            grid[ty * 5 + sy, tx * 5 + sx] |= f
    return grid


def blocking_floor_layer(ds1):
    """Floor layer for editor blocking tiles.

    The first floor layer is used: random outdoor levels merge their DS1 pieces with a fixed
    layer count, and an added floor layer crashed the game there (act 1 Blood Moor, bord12.ds1).
    HD mode does not draw legacy floor tiles, so overwriting the floor cell is invisible.
    DS1 files edited with an earlier editor version keep their extra layer."""
    if ds1.floor_layers >= 2 and any(((v >> 20) & 0x3F) == BLOCK_MAIN for v in ds1.layers[("floor", ds1.floor_layers - 1)]):
        return ds1.floor_layers - 1
    return 0


def apply_ops(ds1, ops, subtiles=None):
    """ops: [{"tx", "ty", "mode": block|blockall|clear|reset}] ; reset needs ds1.original.
    Subtile ops: {"sx", "sy", "mode": sub_block|sub_blockall|sub_clear} (subtile coordinates in the
    DS1) need subtiles (a SubtileTiles). They only change the editor's own blocking, never walls."""
    layer = None
    by_tile = {}
    for op in ops:
        if op["mode"].startswith("sub_"):
            sx, sy = int(op["sx"]), int(op["sy"])
            if 0 <= sx < ds1.width * 5 and 0 <= sy < ds1.height * 5:
                by_tile.setdefault((sx // 5, sy // 5), []).append((sx % 5, sy % 5, op["mode"]))
    if by_tile:
        if subtiles is None:
            raise ValueError("subtile edits need the project's tile set")
        floor = ds1.layers[("floor", 0)]
        orig = getattr(ds1, "original", None)
        for (tx, ty), changes in by_tile.items():
            n = ty * ds1.width + tx
            v = floor[n]
            main, sub = (v >> 20) & 0x3F, (v >> 8) & 0x3F
            if main in CUSTOM_MAINS and (main, sub) in subtiles.by_key:
                flags = bytearray(subtiles.by_key[(main, sub)])
            elif main == BLOCK_MAIN and v:
                flags = bytearray([0x01 if sub == 1 else 0x05] * 25)
            else:
                flags = bytearray(25)
            for x, y, mode in changes:
                flags[flag_index(x, y)] = 0 if mode == "sub_clear" else SUBTILE_FLAG[mode]
            if not any(flags):
                src = orig.layers.get(("floor", 0)) if orig else None
                keep = src[n] if src else 0
                floor[n] = 0 if ((keep >> 20) & 0x3F) in CUSTOM_MAINS + (BLOCK_MAIN,) else keep
            else:
                m, s_ = subtiles.key_for(flags)
                floor[n] = encode_cell(m, s_)
    for op in ops:
        if op["mode"].startswith("sub_"):
            continue
        tx, ty, mode = int(op["tx"]), int(op["ty"]), op["mode"]
        if not (0 <= tx < ds1.width and 0 <= ty < ds1.height):
            continue
        n = ty * ds1.width + tx
        if mode in BLOCK_SUB:
            layer = layer if layer is not None else blocking_floor_layer(ds1)
            ds1.layers[("floor", layer)][n] = encode_cell(BLOCK_MAIN, BLOCK_SUB[mode])
        elif mode == "clear":
            for i in range(ds1.wall_layers):
                ds1.layers[("wall", i)][n] = 0
                ds1.layers[("orient", i)][n] = 0
            orig = getattr(ds1, "original", None)
            for i in range(ds1.floor_layers):
                v = ds1.layers[("floor", i)][n]
                if v and (v >> 20) & 0x3F == BLOCK_MAIN:
                    src = orig.layers.get(("floor", i)) if orig else None
                    keep = src[n] if src and ((src[n] >> 20) & 0x3F) != BLOCK_MAIN else 0
                    ds1.layers[("floor", i)][n] = keep  # the original floor tile comes back
        elif mode == "reset" and getattr(ds1, "original", None):
            orig = ds1.original
            for key, cells in ds1.layers.items():
                src = orig.layers.get(key)
                cells[n] = src[n] if src else 0


def verify_order(ds1, table, points):
    """Pick the subtile order under which the most given HD points (x, z) are blocked."""
    best = None
    for order in ("normal", "flipx", "flipy", "flipxy"):
        g = compute(ds1, table, order)
        hit = sum(1 for x, z in points
                  if 0 <= int(z / 2) < g.shape[0] and 0 <= int(x / 2) < g.shape[1] and g[int(z / 2), int(x / 2)] & 1)
        if best is None or hit > best[1]:
            best = (order, hit)
        print(order, hit, "/", len(points))
    return best
