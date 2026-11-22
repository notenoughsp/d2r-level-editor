"""D2R per-act combined_ds1.bin (data/global/tiles/<act>/combined_ds1.bin).

The game preloads every DS1 of an act from this file (PresetPreloadCombinedDs1, RE catalog),
so loose .ds1 overrides in a mod are not enough: the combined file must be rebuilt.

Layout: u32 count; count x {u32 offset, u32 size, char name[40]} (name relative to the act
folder, e.g. "town/towne1.ds1"); then the DS1 files back to back.

  python -I combined_ds1.py list <combined_ds1.bin>
"""
import struct
import sys

ENTRY = 48
NAME = 40


def read(data):
    count = struct.unpack_from("<I", data, 0)[0]
    out = []
    for i in range(count):
        off, size = struct.unpack_from("<II", data, 4 + i * ENTRY)
        raw = data[4 + i * ENTRY + 8:4 + i * ENTRY + 8 + NAME]
        name = raw.split(b"\0", 1)[0].decode("latin1")
        out.append((name, data[off:off + size]))
    return out


def build(entries):
    head = struct.pack("<I", len(entries))
    off = 4 + ENTRY * len(entries)
    body = bytearray()
    table = bytearray()
    for name, blob in entries:
        nb = name.encode("latin1")
        if len(nb) >= NAME:
            raise ValueError(f"name too long for combined_ds1: {name}")
        table += struct.pack("<II", off + len(body), len(blob)) + nb + b"\0" * (NAME - len(nb))
        body += blob
    return head + bytes(table) + bytes(body)


def replace(data, overrides, add_new=False):
    """overrides: {relative name (lower case): ds1 bytes}. Returns rebuilt bytes and the names
    written. With add_new, names not in the file (new map pieces, e.g. of a new level) are added."""
    entries = read(data)
    done = []
    new = []
    for name, blob in entries:
        key = name.replace("\\", "/").lower()
        if key in overrides:
            new.append((name, overrides[key]))
            done.append(key)
        else:
            new.append((name, blob))
    if add_new:
        for key in sorted(set(overrides) - set(done)):
            new.append((key, overrides[key]))  # names use forward slashes
            done.append(key)
    return build(new), done


if __name__ == "__main__":
    d = open(sys.argv[2], "rb").read()
    entries = read(d)
    print(len(entries), "entries; rebuild identical:", build(entries) == d)
    for n, b in entries[:5]:
        print(f"  {n} {len(b)}")
