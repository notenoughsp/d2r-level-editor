"""Give a character every waypoint in all difficulties: python -I tools/give_waypoints.py <save.d2s>

For test characters only. Refuses saves outside a mod's own save folder
(Saved Games/Diablo II Resurrected/mods/<mod>/). Keeps a copy as <save>.before-waypoints.

Waypoint section: "WS", 6 bytes, then per difficulty 24 bytes: u16 0x0102 and a bit field with
one bit per waypoint (levels.txt column Waypoint gives each level's bit). The save checksum at
offset 12 is recomputed (sum = rol(sum, 1) + byte, with the checksum field zeroed).
"""
import pathlib
import shutil
import struct
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import ingame_test as it  # noqa: E402


def checksum(data):
    b = bytearray(data)
    b[12:16] = b"\0\0\0\0"
    s = 0
    for x in b:
        s = (((s << 1) | (s >> 31)) + x) & 0xFFFFFFFF
    return s


def waypoint_count():
    rows = it.read_asset("data/global/excel/levels.txt").decode("latin1").splitlines()  # project copy: new levels too
    h = rows[0].split("\t")
    wp = [int(r.split("\t")[h.index("Waypoint")]) for r in rows[1:]
          if len(r.split("\t")) > h.index("Waypoint") and r.split("\t")[h.index("Waypoint")].isdigit()]
    return max(w for w in wp if w != 255) + 1


def main():
    p = pathlib.Path(sys.argv[1])
    if "\\mods\\" not in str(p.resolve()) and "/mods/" not in p.resolve().as_posix():
        sys.exit("only for test characters in a mod's own save folder")
    data = bytearray(p.read_bytes())
    ws = data.find(b"WS")
    if ws < 0:
        sys.exit("no waypoint section")
    n = waypoint_count()
    for diff in range(3):
        o = ws + 8 + diff * 24
        if data[o:o + 2] != b"\x02\x01":
            sys.exit(f"unexpected waypoint block at {o}: {data[o:o + 2].hex()}")
        for bit in range(n):
            data[o + 2 + bit // 8] |= 1 << (bit % 8)
    struct.pack_into("<I", data, 12, checksum(data))
    backup = p.with_suffix(".d2s.before-waypoints")
    if not backup.exists():
        shutil.copy2(p, backup)
    p.write_bytes(bytes(data))
    print(f"{p.name}: {n} waypoints in 3 difficulties")


if __name__ == "__main__":
    main()
