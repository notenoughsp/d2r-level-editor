"""Draw a DS1 map piece with the legacy (SD) Diablo II graphics: python -I sd_render.py <ds1> <out.png>

Tiles come from the DT1 files the DS1 lists (plus the always-loaded ones), colours from the act
palette (data/global/palette/<act>/pal.dat, 256 x BGR). Isometric layout as in the game: tile
(x, y) has its top corner at ((x - y) * 80, (x + y) * 40).

DT1 tile graphics: a tile header points (absolute offset) to its block headers; each 20-byte block
header has x, y (i16), grid x/y, format and length, and the data offset relative to the block
headers. Format 1 is an isometric 32 x 15 diamond (256 bytes, fixed row widths), every other
format is RLE: byte pairs (skip, count), (0, 0) ends a row.
"""
import struct
import sys

import numpy as np
from PIL import Image

ISO_WIDTH = [4, 8, 12, 16, 20, 24, 28, 32, 28, 24, 20, 16, 12, 8, 4]
ISO_X = [14, 12, 10, 8, 6, 4, 2, 0, 2, 4, 6, 8, 10, 12, 14]


class TileSet:
    """All tiles of a list of DT1 files: (orientation, main, sub) -> (raw file, tile header offset)."""

    def __init__(self, files):
        self.tiles = {}
        self.cache = {}
        for raw in files:
            count, off = struct.unpack_from("<ii", raw, 268)
            for i in range(count):
                o = off + i * 96
                orient, main, sub, rarity = struct.unpack_from("<iiii", raw, o + 20)
                key = (orient, main, sub)
                # the game picks a variant by rarity; the first one is shown here
                if key not in self.tiles:
                    self.tiles[key] = (raw, o)

    def image(self, key):
        """Palette-index image of a tile and the top-left of its pixels relative to the tile origin."""
        if key in self.cache:
            return self.cache[key]
        hit = self.tiles.get(key)
        if not hit:
            self.cache[key] = None
            return None
        raw, o = hit
        bho, _len, bcount = struct.unpack_from("<iii", raw, o + 72)
        blocks = []
        for b in range(bcount):
            bx, by, _u, _gx, _gy, fmt, length, _u2, foff = struct.unpack_from("<hhHBBHiHi", raw, bho + b * 20)
            blocks.append((bx, by, fmt, raw[bho + foff:bho + foff + length]))
        if not blocks:
            self.cache[key] = None
            return None
        x0 = min(b[0] for b in blocks)
        y0 = min(b[1] for b in blocks)
        x1 = max(b[0] for b in blocks) + 32
        y1 = max(b[1] for b in blocks) + 32
        idx = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
        mask = np.zeros_like(idx, dtype=bool)
        for bx, by, fmt, data in blocks:
            ox, oy = bx - x0, by - y0
            if fmt == 1:
                p = 0
                for row in range(15):
                    w = ISO_WIDTH[row]
                    xs = ox + ISO_X[row]
                    idx[oy + row, xs:xs + w] = np.frombuffer(data, np.uint8, w, p)
                    mask[oy + row, xs:xs + w] = True
                    p += w
            else:
                p, x, y = 0, 0, 0
                while p + 1 < len(data):
                    skip, n = data[p], data[p + 1]
                    p += 2
                    if skip == 0 and n == 0:
                        x, y = 0, y + 1
                        continue
                    x += skip
                    if oy + y < idx.shape[0] and n:
                        end = min(ox + x + n, idx.shape[1])
                        idx[oy + y, ox + x:end] = np.frombuffer(data, np.uint8, end - ox - x, p)
                        mask[oy + y, ox + x:end] = True
                    p += n
                    x += n
        self.cache[key] = (idx, mask, x0, y0)
        return self.cache[key]


def palette(read_asset, act_folder):
    pal = read_asset(f"data/global/palette/{act_folder}/pal.dat", original=True)
    bgr = np.frombuffer(pal, np.uint8).reshape(256, 3)
    return bgr[:, ::-1].copy()


def render(ds1, read_asset, tile_paths, act_folder):
    files = []
    for p in tile_paths:
        try:
            files.append(read_asset(p))
        except (FileNotFoundError, KeyError):
            continue
    tiles = TileSet(files)
    pal = palette(read_asset, act_folder)
    w, h = ds1.width, ds1.height
    width = (w + h) * 80 + 160
    top = 320  # room for tall walls on the first rows
    height = (w + h) * 40 + top + 120
    out = np.zeros((height, width, 3), dtype=np.uint8)
    out[:] = (12, 12, 14)
    cx = h * 80

    def blit(key, px, py):
        t = tiles.image(key)
        if not t:
            return
        idx, mask, x0, y0 = t
        X, Y = px + x0, py + y0
        if X < 0 or Y < 0 or X + idx.shape[1] > width or Y + idx.shape[0] > height:
            return
        region = out[Y:Y + idx.shape[0], X:X + idx.shape[1]]
        region[mask] = pal[idx[mask]]

    def cell(v):
        return (v >> 20) & 0x3F, (v >> 8) & 0x3F, bool(v & 0x80000000)

    order = sorted(((x, y) for y in range(h) for x in range(w)), key=lambda c: (c[0] + c[1], c[0]))
    for i in range(ds1.floor_layers):
        layer = ds1.layers[("floor", i)]
        for x, y in order:
            v = layer[y * w + x]
            main, sub, hidden = cell(v)
            if v and not hidden:
                blit((0, main, sub), cx + (x - y) * 80, top + (x + y) * 40)
    for x, y in order:
        for i in range(ds1.wall_layers):
            v = ds1.layers[("wall", i)][y * w + x]
            o = ds1.layers[("orient", i)][y * w + x] & 0xFF
            main, sub, hidden = cell(v)
            if not v or hidden or o in (0, 10, 11, 15) or o >= 16:
                continue  # floor-like, special, roof and lower-wall orientations are not drawn here
            px, py = cx + (x - y) * 80, top + (x + y) * 40 + 80
            blit((o, main, sub), px, py)
            if o == 3:  # a corner draws its other half too
                blit((4, main, sub), px, py)
    return Image.fromarray(out)


if __name__ == "__main__":
    sys.argv[1:1] = []
