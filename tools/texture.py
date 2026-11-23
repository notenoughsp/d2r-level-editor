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
    0x39: ("BC1_UNORM", 8, 0),        # flow maps (decode check 2026-11-23: 0.5 byte/pixel, BC1 smooth)
    0x3A: ("BC1_UNORM_SRGB", 8, 0),   # albedo with alpha cut-outs; was wrongly BC3
    0x3F: ("BC4_UNORM", 8, 0),        # single-channel masks (orm$g, glow masks)
    0x41: ("BC5_UNORM", 16, 0),       # two-channel distortion maps
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


# ---- writing (tools/retexture.py) ----

def _pack_bits(values, bits):
    """values: (..., 16) small ints -> little-endian bit stream per row as int64 pieces."""
    import numpy as np
    out = np.zeros(values.shape[:-1], dtype=np.uint64)
    for i in range(values.shape[-1]):
        out |= values[..., i].astype(np.uint64) << np.uint64(i * bits)
    return out


def _blocks(img):
    """(H, W, 4) uint8 -> (H/4 * W/4, 16, 4) float, padding small mips to whole blocks."""
    import numpy as np
    h, w = img.shape[:2]
    ph, pw = (-h) % 4, (-w) % 4
    if ph or pw:
        img = np.pad(img, ((0, ph), (0, pw), (0, 0)), mode="edge")
    h, w = img.shape[:2]
    b = img.reshape(h // 4, 4, w // 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(-1, 16, 4)
    return b.astype(np.float32)


def _encode_color(px):
    """BC1 colour part (4-colour mode) of blocks px (N, 16, 3) -> (N,) uint64 (8 bytes each)."""
    import numpy as np
    hi, lo = px.max(axis=1), px.min(axis=1)
    inset = (hi - lo) / 16.0
    hi, lo = hi - inset, lo + inset

    def to565(c):
        r = np.clip(np.round(c[:, 0] * 31 / 255), 0, 31).astype(np.uint32)
        g = np.clip(np.round(c[:, 1] * 63 / 255), 0, 63).astype(np.uint32)
        b = np.clip(np.round(c[:, 2] * 31 / 255), 0, 31).astype(np.uint32)
        return (r << 11) | (g << 5) | b

    def from565(v):
        return np.stack([((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31], axis=1)

    c0, c1 = to565(hi), to565(lo)
    swap = c0 < c1
    c0, c1 = np.where(swap, c1, c0), np.where(swap, c0, c1)
    e0, e1 = from565(c0), from565(c1)
    d = e1 - e0
    dd = (d * d).sum(axis=1)
    t = ((px - e0[:, None, :]) * d[:, None, :]).sum(axis=2) / np.maximum(dd, 1e-6)[:, None]
    idx = np.where(t < 1 / 6, 0, np.where(t < 0.5, 2, np.where(t < 5 / 6, 3, 1))).astype(np.uint32)
    idx[c0 == c1] = 0
    bits = _pack_bits(idx, 2)
    return c0.astype(np.uint64) | (c1.astype(np.uint64) << np.uint64(16)) | (bits << np.uint64(32))


def _encode_alpha(a):
    """BC4 block of values a (N, 16) -> (N,) uint64."""
    import numpy as np
    a0 = np.round(a.max(axis=1)).astype(np.uint32)
    a1 = np.round(a.min(axis=1)).astype(np.uint32)
    span = np.maximum(a0 - a1, 1).astype(np.float32)
    k = np.clip(np.round((a0[:, None] - a) / span[:, None] * 7), 0, 7).astype(np.uint32)
    idx = np.where(k == 0, 0, np.where(k == 7, 1, k + 1))
    idx[a0 == a1] = 0
    bits = _pack_bits(idx, 3)
    return a0.astype(np.uint64) | (a1.astype(np.uint64) << np.uint64(8)) | (bits << np.uint64(16))


def encode_bc3(img):
    """(H, W, 4) uint8 RGBA -> BC3 bytes (alpha block, then colour block, per 4x4 block)."""
    import numpy as np
    b = _blocks(img)
    alpha = _encode_alpha(b[:, :, 3])
    color = _encode_color(b[:, :, :3])
    return np.stack([alpha, color], axis=1).astype("<u8").tobytes()


def write_texture(img, fmt=0x3E):
    """RGBA image (PIL image or array, power-of-two size) -> D2R .texture with a full mip chain.
    0x3E = BC3 sRGB (albedo), 0x3D = BC3 linear (normal, orm)."""
    import numpy as np
    from PIL import Image
    im = img if isinstance(img, Image.Image) else Image.fromarray(np.asarray(img, dtype=np.uint8))
    im = im.convert("RGBA")
    w, h = im.size
    width, height = w, h
    levels = []
    while True:
        levels.append(encode_bc3(np.asarray(im)))
        if w == 1 and h == 1:
            break
        w, h = max(1, w // 2), max(1, h // 2)
        im = im.resize((w, h), Image.LANCZOS)
    n = len(levels)
    head = bytearray(0x24 + 8 * n)
    struct.pack_into("<IBBBB", head, 0, MAGIC, fmt, 0, 2, n)
    struct.pack_into("<III", head, 8, width, height, 1)
    struct.pack_into("<II", head, 0x1C, n, 4)
    offset = len(head)
    for i, data in enumerate(levels):
        pos = 0x24 + 8 * i
        struct.pack_into("<II", head, pos, len(data), offset - (pos + 4))
        offset += len(data)
    return bytes(head) + b"".join(levels)


def read_rgba(data):
    """D2R .texture -> PIL RGBA image of mip 0."""
    import io
    from PIL import Image
    name = FORMATS.get(parse(data)["format"], ("BC3_UNORM",))[0].replace("_SRGB", "")  # Pillow has no sRGB BCn
    return Image.open(io.BytesIO(to_dds(data, name))).convert("RGBA")


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
