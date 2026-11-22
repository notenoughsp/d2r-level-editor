"""Read Diablo II .dt1 tile sets: tile keys and the 5x5 subtile collision flags.

Header: i32 version1 (7), i32 version2 (6), 260 zero bytes, i32 tileCount, i32 tileHeaderOffset.
Tile header (96 bytes):
  i32 direction, i16 roofY, u8 sound, u8 animated, i32 sizeY, i32 sizeX, i32 zero,
  i32 orientation, i32 mainIndex, i32 subIndex, i32 rarity, u8 unknown[4],
  u8 subtileFlags[25], u8 zero[7], i32 blockHeaderOffset, i32 blockDataLength, i32 blockCount,
  u8 zero[12]
Subtile flag bits: 0x01 block walk, 0x02 block light/line of sight, 0x04 block jump/teleport,
0x08 block player walk (monsters pass), 0x10 unknown, 0x20 block light only, 0x40 unknown, 0x80 unknown.

  python -I dt1.py info <file.dt1>
"""
import struct
import sys


class DT1:
    def __init__(self, data):
        v1, v2 = struct.unpack_from("<ii", data, 0)
        if (v1, v2) != (7, 6):
            raise ValueError(f"unsupported dt1 version {v1}.{v2}")
        count, off = struct.unpack_from("<ii", data, 268)
        self.tiles = []
        for i in range(count):
            o = off + i * 96
            direction, roof_y, sound, animated, size_y, size_x, _z, orient, main, sub, rarity = \
                struct.unpack_from("<ihBBiiiiiii", data, o)
            flags = data[o + 40:o + 65]
            self.tiles.append({"direction": direction, "orientation": orient, "main": main, "sub": sub,
                               "rarity": rarity, "flags": bytes(flags), "size": (size_x, size_y)})

    def by_key(self):
        """(orientation, main, sub) -> highest-rarity tile (the game picks a variant by rarity)."""
        out = {}
        for t in self.tiles:
            k = (t["orientation"], t["main"], t["sub"])
            if k not in out or t["rarity"] > out[k]["rarity"]:
                out[k] = t
        return out


def add_tiles(raw, template_index, new_tiles):
    """Copy of a .dt1 with extra tiles: new_tiles = [(orientation, main, sub, flags25)].

    Every new tile is a copy of tile template_index (sharing its graphics blocks: block offsets
    in a tile header are absolute file offsets and are moved by the inserted headers)."""
    count, off = struct.unpack_from("<ii", raw, 268)
    end = off + count * 96
    delta = 96 * len(new_tiles)
    headers = bytearray(raw[off:end])
    for i in range(count):  # existing tiles: their blocks move back by the new headers
        o = i * 96 + 72
        struct.pack_into("<i", headers, o, struct.unpack_from("<i", headers, o)[0] + delta)
    tpl = bytes(headers[template_index * 96:(template_index + 1) * 96])
    for orient, main, sub, flags in new_tiles:
        h = bytearray(tpl)
        struct.pack_into("<iii", h, 20, orient, main, sub)
        h[40:65] = bytes(flags)
        headers += h
    out = bytearray(raw[:off]) + headers + raw[end:]
    struct.pack_into("<i", out, 268, count + len(new_tiles))
    return bytes(out)


if __name__ == "__main__":
    d = DT1(open(sys.argv[2], "rb").read())
    print(len(d.tiles), "tiles")
    for t in d.tiles[:40]:
        print(f"orient {t['orientation']:2} main {t['main']:2} sub {t['sub']:2} rarity {t['rarity']:3} "
              f"flags {t['flags'].hex(' ')}")
