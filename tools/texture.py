"""D2R HD .texture files.

Layout (little endian):
  +0x00 u32  magic '<DE(' (0x2845443C)
  +0x04 u8   format code (see FORMATS)
  +0x05 u8   ?
  +0x06 u8   ? (2)
  +0x07 u8   mip count
  +0x08 u32  width
  +0x0C u32  height
  +0x10 u32  depth/array size (1)
  +0x1C u32  mip count
  +0x20 u32  ?
  +0x24      mip table: per mip {u32 size; u32 offset relative to this field}
Data follows the table (mip 0 first).

  python -I texture.py info <file.texture>
  python -I texture.py png  <file.texture> <out.png> [format override]
  python -I texture.py dds  <file.texture> <out.dds>
"""
import struct
import sys

MAGIC = 0x2845443C

# format code -> (DXGI format, bytes per 4x4 block or 0 for uncompressed, bytes per pixel)
FORMATS = {
    0x1F: ("R8G8B8A8_UNORM", 0, 4),
    0x38: ("BC1_UNORM", 8, 0),
    0x3A: ("BC3_UNORM", 16, 0),
    0x3C: ("BC4_UNORM", 8, 0),
    0x3D: ("BC3_UNORM", 16, 0),       # linear (orm)
    0x3E: ("BC3_UNORM_SRGB", 16, 0),  # albedo, normal (verified visually)
}
DXGI = {"R8G8B8A8_UNORM": 28, "BC1_UNORM": 71, "BC2_UNORM": 74, "BC3_UNORM": 77, "BC4_UNORM": 80,
        "BC5_UNORM": 83, "BC7_UNORM": 98, "BC7_UNORM_SRGB": 99, "BC1_UNORM_SRGB": 72, "BC3_UNORM_SRGB": 78}


def parse(data):
    if struct.unpack_from("<I", data, 0)[0] != MAGIC:
        raise ValueError("not a D2R texture")
    fmt = data[4]
    width, height, depth = struct.unpack_from("<III", data, 8)
    mips = struct.unpack_from("<I", data, 0x1C)[0]
    table = []
    for i in range(mips):
        pos = 0x24 + 8 * i
        size, rel = struct.unpack_from("<II", data, pos)
        table.append((pos + 4 + rel, size))
    return {"format": fmt, "width": width, "height": height, "depth": depth, "mips": table}


def to_dds(data, fmt_name=None):
    t = parse(data)
    name = fmt_name or FORMATS.get(t["format"], ("BC7_UNORM", 16, 0))[0]
    off, size = t["mips"][0]
    w, h = t["width"], t["height"]
    flags = 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000
    header = struct.pack("<4sIIIIIII44x", b"DDS ", 124, flags, h, w, size, 1, 1)
    pf = struct.pack("<II4sIIIII", 32, 0x4, b"DX10", 0, 0, 0, 0, 0)
    caps = struct.pack("<IIII4x", 0x1000, 0, 0, 0)
    dx10 = struct.pack("<IIIII", DXGI[name], 3, 0, 1, 0)
    return header + pf + caps + dx10 + data[off:off + size]


def main():
    cmd, path = sys.argv[1], sys.argv[2]
    data = open(path, "rb").read()
    if cmd == "info":
        t = parse(data)
        print(f"format 0x{t['format']:02x} {FORMATS.get(t['format'], ('?',))[0]} {t['width']}x{t['height']} mips {len(t['mips'])}")
        print("mip0 offset/size", t["mips"][0])
    elif cmd == "dds":
        open(sys.argv[3], "wb").write(to_dds(data))
    elif cmd == "png":
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(to_dds(data, sys.argv[4] if len(sys.argv) > 4 else None)))
        img.save(sys.argv[3])
        print("saved", sys.argv[3], img.size, img.mode)


if __name__ == "__main__":
    main()
