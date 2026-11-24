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

# Finer collision than a whole tile does not work in the game (tests of 2026-11-22/23): tiles added
# to Blank.dt1 block the whole tile whatever their flags, and the partial blockers of InvisWal.dt1
# (orientation 0, main 49) block the whole tile too, also with InvisWal added to the level type in
# lvltypes.txt. The game honours partial flags only of tiles the area loads by itself, so the
# editor paints whole tiles. See docs/technical.md.


def flag_index(x, y):
    """Index in the 25 subtile flags of subtile (x, y) inside a tile (ORDER flipy)."""
    return (4 - y) * 5 + x


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


def apply_ops(ds1, ops):
    """ops: [{"tx", "ty", "mode": block|blockall|clear|reset}] in tiles; reset needs ds1.original."""
    layer = None
    for op in ops:
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
