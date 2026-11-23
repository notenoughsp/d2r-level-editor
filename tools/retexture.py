"""Retexture D2R HD models: copies of a model with new albedo textures.

A D2R .model is a Granny file; its materials name their textures by full path. This tool
writes a copy of every LOD file of a model in which the albedo texture paths point to new
.texture files, and writes those textures (made from a picture or from the original texture
with a colour change). The originals stay untouched, so the new model can stand next to the old
one in the same map.

Granny details: sections are BitKnit2-compressed in the game files. The copy is written with
uncompressed sections (compression 0), which Granny reads as well, so the texture path strings
can be changed in place. The game draws only models listed in data/hd/model_lod_desc.bin, so
the copy gets an entry there (the project keeps its own copy of that file). A new path has the same length as the old one: "data/hd/env/texture/"
becomes "data/hd/env/tx_<tag>/" with a four-letter tag. The file CRC (CRC-32 of everything from
the section table on) is written new.

  python -I tools/retexture.py <model path> <tag> tint <r> <g> <b> [strength]
  python -I tools/retexture.py <model path> <tag> image <picture.png>
(model path as in a preset, e.g. data/hd/env/model/act1/.../l_barrel01.model; the result goes
into the editor project as <name>_<tag>.model)
"""
import pathlib
import re
import struct
import sys
import zlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import gr2  # noqa: E402
import texture  # noqa: E402

HEADER = 0x20
TAG = re.compile(r"^[a-z0-9]{4}$")


def _table(raw, comp, off, count):
    if not count:
        return b""
    size = count * 12
    if comp:
        csize = struct.unpack_from("<I", raw, off)[0]
        return gr2.decompress(comp, raw[off + 4:off + 4 + csize], size)
    return bytes(raw[off:off + size])


def rewrite(raw, replace):
    """Granny file -> the same file with uncompressed sections and the byte strings in
    `replace` ({old: new}, same length, NUL-terminated in the file) replaced."""
    if raw[:16] != gr2.MAGIC_LE64:
        raise ValueError("not a 64-bit little-endian Granny file")
    sec_off, sec_count = struct.unpack_from("<II", raw, HEADER + 12)
    table_pos = HEADER + sec_off
    sections = []
    for i in range(sec_count):
        h = list(struct.unpack_from("<11I", raw, table_pos + i * 44))
        comp, doff, dsize, usize = h[:4]
        data = bytearray(gr2.decompress(comp, raw[doff:doff + dsize], usize)) if usize else bytearray()
        for old, new in replace.items():
            if len(old) != len(new):
                raise ValueError(f"new path must have the same length: {old!r}")
            data = data.replace(old + b"\0", new + b"\0")
        sections.append((h, data, _table(raw, comp, h[7], h[8]), _table(raw, comp, h[9], h[10])))
    out = bytearray(raw[:table_pos + sec_count * 44])
    pos = len(out)

    def put(blob, align=32):
        nonlocal pos
        pad = (-pos) % align
        out.extend(b"\0" * pad)
        pos += pad
        at = pos
        out.extend(blob)
        pos += len(blob)
        return at

    for i, (h, data, fix, marsh) in enumerate(sections):
        h = list(h)
        h[0] = 0
        h[1] = put(data)
        h[2] = h[3] = len(data)
        h[7] = put(fix, 4)
        h[9] = put(marsh, 4)
        struct.pack_into("<11I", out, table_pos + i * 44, *h)
    struct.pack_into("<I", out, HEADER + 4, len(out))
    struct.pack_into("<I", out, HEADER + 8, zlib.crc32(out[table_pos:]) & 0xFFFFFFFF)
    return bytes(out)


def albedo_paths(raw):
    """Albedo texture paths of the materials the model's meshes use (a model file also carries
    a material library with other textures; those stay as they are)."""
    import model_export  # noqa: PLC0415
    root = gr2.Granny(raw).root()
    found = []
    for mesh in root.get("Meshes") or []:
        for b in mesh.get("MaterialBindings") or []:
            p = model_export.texture_of(b.get("Material") if b else None)
            if p and p.lower().endswith("_alb.texture") and p not in found:
                found.append(p)
    return found


def new_texture_path(path, tag):
    if not path.lower().startswith("data/hd/env/texture/"):
        raise ValueError(f"texture outside data/hd/env/texture: {path}")
    # The file name changes too (its first four letters become the tag): two copies of a model
    # with textures of the same file name in different folders showed the same texture in game.
    folder, name = path[len("data/hd/env/texture"):].rsplit("/", 1)
    if len(name) < len(".texture") + 8:
        raise ValueError(f"texture name too short to tag: {path}")
    return "data/hd/env/tx_" + tag + folder + "/" + tag + name[4:]


def tinted(image, rgb, strength=0.85):
    """Keep the brightness and the detail, take the colour rgb (0-255)."""
    import numpy as np
    from PIL import Image
    a = np.asarray(image.convert("RGBA")).astype(np.float32) / 255
    lum = a[..., :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    tint = np.array(rgb, dtype=np.float32) / 255 / max(1e-3, (np.array(rgb) / 255 @ [0.299, 0.587, 0.114]))
    a[..., :3] = np.clip(a[..., :3] * (1 - strength) + (lum[..., None] * tint) * strength, 0, 1)
    return Image.fromarray((a * 255 + 0.5).astype(np.uint8), "RGBA")


LOD_DESC = "data/hd/model_lod_desc.json"
LOD_BIN = "data/hd/model_lod_desc.bin"
ENTRY = 44


def fnv1a(path):
    h = 0x811C9DC5
    for c in path.lower().encode():
        h = ((h ^ c) * 0x01000193) & 0xFFFFFFFF
    return h


def lod_bin_add(data, new):
    """The game's model list data/hd/model_lod_desc.bin with entries added. new: {new model path:
    existing model path}; the new entry is a copy of the existing one (bounds and LOD data).

    Layout (D2Render model_asset_cache.cpp, read at RVA 0xF75C60, searched at 0xF75AF0):
      +0  u32 entry count, +4 i32 offset from +4 to the entries (20)
      +8  u32 ?, +12 i32 offset from +12 to the data after the entries, +16 u32 ?,
      +20 i32 offset from +20 to a later block
      +24 entries of 44 bytes sorted by hash: u32 FNV-1a hash of the lower-case path,
          6 floats bounds, u32 flags, u32 LOD count, i32 offset (from that field) to the
          model's LOD data, u32 flags
    The data after the entries stays as it is; only the offsets pointing into it change."""
    count, rel0 = struct.unpack_from("<Ii", data, 0)
    start = 4 + rel0
    end = start + count * ENTRY
    entries = {}
    for k in range(count):
        pos = start + k * ENTRY
        e = bytearray(data[pos:pos + ENTRY])
        h = struct.unpack_from("<I", e, 0)[0]
        target = pos + 36 + struct.unpack_from("<i", e, 36)[0]
        entries[h] = (e, target)
    added = 0
    for path, like in new.items():
        h, src = fnv1a(path), fnv1a(like)
        if src not in entries:
            raise ValueError(f"{like} is not in {LOD_BIN}")
        if h in entries:
            continue
        e, target = entries[src]
        e = bytearray(e)
        struct.pack_into("<I", e, 0, h)
        entries[h] = (e, target)
        added += 1
    delta = added * ENTRY
    out = bytearray(data[:start])
    struct.pack_into("<I", out, 0, len(entries))
    for field in (12, 20):  # header offsets into the data after the entries move with it
        val = struct.unpack_from("<i", out, field)[0]
        if field + val >= end:
            struct.pack_into("<i", out, field, val + delta)
    for k, h in enumerate(sorted(entries)):
        e, target = entries[h]
        pos = start + k * ENTRY
        new_target = target + delta if target >= end else target
        e = bytearray(e)
        struct.pack_into("<i", e, 36, new_target - (pos + 36))
        out.extend(e)
    out.extend(data[end:])
    return bytes(out)


def register_model(new_path, like_path, read_current, write_asset):
    """The game knows a model only through data/hd/model_lod_desc.bin (hash of the path, bounds,
    LOD data); without an entry a model is never drawn. The json twin gets the entry too."""
    import json
    write_asset(LOD_BIN, lod_bin_add(read_current(LOD_BIN), {new_path: like_path}))
    desc = json.loads(read_current(LOD_DESC))
    if like_path in desc:
        desc[new_path] = dict(desc[like_path])
        write_asset(LOD_DESC, json.dumps(desc, separators=(",", ":")).encode())


def retexture(model_path, tag, make_albedo, read_asset, write_asset, read_current=None):
    """Copy all LOD files of model_path as <name>_<tag>_lodN.model with new albedo textures.
    make_albedo(original PIL image, texture path) -> new PIL image. Returns the new model path."""
    if not TAG.match(tag):
        raise ValueError("tag: four letters or digits, e.g. gold")
    base = model_path[:-len(".model")] if model_path.endswith(".model") else model_path
    new_base = f"{base}_{tag}"
    lods = []
    for lod in range(8):
        try:
            lods.append((lod, read_asset(f"{base}_lod{lod}.model")))
        except FileNotFoundError:
            break
    if not lods:
        raise FileNotFoundError(f"{base}_lod0.model")
    done = {}
    for lod, raw in lods:
        paths = albedo_paths(raw)
        replace = {}
        for p in paths:
            q = new_texture_path(p, tag)
            replace[p.encode()] = q.encode()
            if q not in done:
                original = texture.read_rgba(read_asset(p))
                fmt = texture.parse(read_asset(p))["format"]
                write_asset(q, texture.write_texture(make_albedo(original, p), 0x3E if fmt in (0x3E, 0x3A) else fmt))
                done[q] = p
        write_asset(f"{new_base}_lod{lod}.model", rewrite(raw, replace))
    register_model(f"{new_base}.model", model_path, read_current or read_asset, write_asset)
    return f"{new_base}.model", done


def main():
    import server  # noqa: PLC0415 (editor project paths and game files)
    model, tag, mode = sys.argv[1], sys.argv[2], sys.argv[3]
    if mode == "tint":
        rgb = tuple(int(v) for v in sys.argv[4:7])
        strength = float(sys.argv[7]) if len(sys.argv) > 7 else 0.85
        make = lambda img, _p: tinted(img, rgb, strength)  # noqa: E731
    elif mode == "image":
        from PIL import Image
        picture = Image.open(sys.argv[4]).convert("RGBA")
        make = lambda img, _p: picture.resize(img.size)  # noqa: E731
    else:
        sys.exit(__doc__)

    def write(path, data):
        dst = server.PROJECT / path
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
    new, textures = retexture(model, tag, make, lambda p: server.read_asset(p, original=True), write, server.read_asset)
    print(new)
    for q, p in textures.items():
        print(" ", p, "->", q)


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
    main()
