"""Import a new 3D mesh into D2R as a game model.

D2R models are Granny files. Writing one from scratch would need the whole Granny type tree, so
this tool takes an existing game model with one mesh as a template and replaces its geometry:
the new vertices and triangles are appended to the file's data section and the template's array
pointers are pointed at them (pointer fixups), all other data (skeleton, materials, render
settings) stays. The materials keep their shader settings; their albedo textures are replaced
by the new model's texture (as tools/retexture.py does). The new model gets an entry in
data/hd/model_lod_desc.bin with its own bounds and one LOD (with the template's five LODs and
the new mesh in every LOD file the game did not draw the model).

Vertex layout of the env templates (20 bytes): position int16 x3 + w (x / 32767 * VertexScale),
normal int8 x3 + 0 (/127), tangent int8 x3 + sign (+-127), uv float16 x2.

  python -I tools/meshimport.py <mesh.obj | mesh.glb> <new model path> [texture.png] [height]
"""
import json
import pathlib
import re
import struct
import sys
import zlib

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import gr2  # noqa: E402
import retexture  # noqa: E402
import texture  # noqa: E402

HEADER = 0x20
TEMPLATE = "data/hd/env/model/act1/catacomb/act1_catacomb_walls/pillar01"


# ---------------------------------------------------------------- editable Granny file
class GrannyFile:
    """Decompressed sections plus fixup tables; addresses as gr2.Granny uses them."""

    def __init__(self, raw):
        self.raw = raw
        self.g = gr2.Granny(raw)
        sec_off, sec_count = struct.unpack_from("<II", raw, HEADER + 12)
        self.table_pos = HEADER + sec_off
        self.heads, self.data, self.fix, self.marsh = [], [], [], []
        for i in range(sec_count):
            h = list(struct.unpack_from("<11I", raw, self.table_pos + i * 44))
            comp, doff, dsize, usize = h[:4]
            self.heads.append(h)
            self.data.append(bytearray(gr2.decompress(comp, raw[doff:doff + dsize], usize)) if usize else bytearray())
            fx = retexture._table(raw, comp, h[7], h[8])
            self.fix.append([list(struct.unpack_from("<III", fx, k * 12)) for k in range(h[8])])
            self.marsh.append(retexture._table(raw, comp, h[9], h[10]))

    def loc(self, addr):
        for i, b in enumerate(self.g.base):
            if b <= addr < b + 0x1000_0000_0000:
                return i, addr - b
        raise ValueError(hex(addr))

    def put(self, addr, fmt, *values):
        sec, off = self.loc(addr)
        struct.pack_into("<" + fmt, self.data[sec], off, *values)

    def append(self, sec, blob, align=16):
        d = self.data[sec]
        d.extend(b"\0" * ((-len(d)) % align))
        off = len(d)
        d.extend(blob)
        return off

    def point(self, addr, tsec, toff):
        """Make the pointer at addr point to (tsec, toff)."""
        sec, off = self.loc(addr)
        for f in self.fix[sec]:
            if f[0] == off:
                f[1], f[2] = tsec, toff
                return
        self.fix[sec].append([off, tsec, toff])

    def field(self, type_addr, obj_addr, name):
        a = obj_addr
        for t, n, d, count in self.g.members(type_addr):
            if n == name:
                return t, d, a
            a += self.g.member_size(t, d) * max(count, 1)
        raise KeyError(name)

    def to_bytes(self):
        out = bytearray(self.raw[:self.table_pos + len(self.heads) * 44])
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

        for i, h in enumerate(self.heads):
            h = list(h)
            fix = b"".join(struct.pack("<III", *f) for f in sorted(self.fix[i]))
            h[0] = 0
            h[1] = put(bytes(self.data[i]))
            h[2] = h[3] = len(self.data[i])
            h[7] = put(fix, 4)
            h[8] = len(self.fix[i])
            h[9] = put(self.marsh[i], 4)
            struct.pack_into("<11I", out, self.table_pos + i * 44, *h)
        struct.pack_into("<I", out, HEADER + 4, len(out))
        struct.pack_into("<I", out, HEADER + 8, zlib.crc32(out[self.table_pos:]) & 0xFFFFFFFF)
        return bytes(out)


# ---------------------------------------------------------------- mesh readers
def read_obj(path):
    """Positions, uvs, normals and triangles of an OBJ file (one mesh; faces are fanned)."""
    vs, vts, vns, out_v, out_t, out_n, tris, seen = [], [], [], [], [], [], [], {}
    for line in pathlib.Path(path).read_text(errors="replace").splitlines():
        p = line.split()
        if not p:
            continue
        if p[0] == "v":
            vs.append([float(x) for x in p[1:4]])
        elif p[0] == "vt":
            vts.append([float(x) for x in p[1:3]])
        elif p[0] == "vn":
            vns.append([float(x) for x in p[1:4]])
        elif p[0] == "f":
            ids = []
            for c in p[1:]:
                k = c.split("/")
                key = tuple(k)
                if key not in seen:
                    seen[key] = len(out_v)
                    out_v.append(vs[int(k[0]) - 1])
                    out_t.append(vts[int(k[1]) - 1] if len(k) > 1 and k[1] else [0.0, 0.0])
                    out_n.append(vns[int(k[2]) - 1] if len(k) > 2 and k[2] else [0.0, 1.0, 0.0])
                ids.append(seen[key])
            for i in range(1, len(ids) - 1):
                tris.append([ids[0], ids[i], ids[i + 1]])
    return np.array(out_v, np.float32), np.array(out_t, np.float32), np.array(out_n, np.float32), np.array(tris, np.uint32)


def read_glb(path):
    """All triangle primitives of a binary glTF (node transforms applied), merged into one mesh;
    also the first base colour image if the file embeds one."""
    data = pathlib.Path(path).read_bytes()
    jlen = struct.unpack_from("<I", data, 12)[0]
    j = json.loads(data[20:20 + jlen])
    bin_off = 20 + jlen + 8
    blob = data[bin_off:]

    def acc(i):
        a = j["accessors"][i]
        bv = j["bufferViews"][a["bufferView"]]
        comp = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}[a["componentType"]]
        n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride", 0) or n * np.dtype(comp).itemsize
        raw = np.frombuffer(blob, np.uint8, count=stride * (a["count"] - 1) + n * np.dtype(comp).itemsize, offset=start)
        rows = np.lib.stride_tricks.as_strided(raw, (a["count"], n * np.dtype(comp).itemsize), (stride, 1))
        return np.ascontiguousarray(rows).view(comp).reshape(a["count"], n)

    def matrix(node):
        if "matrix" in node:
            return np.array(node["matrix"], np.float64).reshape(4, 4).T
        t = np.eye(4)
        if "scale" in node:
            t = np.diag(list(node["scale"]) + [1.0]) @ t
        if "rotation" in node:
            x, y, z, w = node["rotation"]
            r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
                          [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
                          [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0], [0, 0, 0, 1]])
            t = r @ t
        if "translation" in node:
            m = np.eye(4)
            m[:3, 3] = node["translation"]
            t = m @ t
        return t

    P, T, N, F = [], [], [], []
    scene = j["scenes"][j.get("scene", 0)]

    def walk(ni, parent):
        node = j["nodes"][ni]
        m = parent @ matrix(node)
        if "mesh" in node:
            for prim in j["meshes"][node["mesh"]]["primitives"]:
                if prim.get("mode", 4) != 4:
                    continue
                pos = acc(prim["attributes"]["POSITION"]).astype(np.float64)
                pos = (np.c_[pos, np.ones(len(pos))] @ m.T)[:, :3]
                nrm = acc(prim["attributes"]["NORMAL"]).astype(np.float64) if "NORMAL" in prim["attributes"] else np.tile([0, 1.0, 0], (len(pos), 1))
                nrm = nrm @ np.linalg.inv(m[:3, :3]).T
                uv = acc(prim["attributes"]["TEXCOORD_0"]) if "TEXCOORD_0" in prim["attributes"] else np.zeros((len(pos), 2))
                idx = acc(prim["indices"]).reshape(-1, 3) if "indices" in prim else np.arange(len(pos)).reshape(-1, 3)
                F.append(idx.astype(np.uint32) + sum(len(p) for p in P))
                P.append(pos)
                N.append(nrm)
                T.append(uv)
        for c in node.get("children", []):
            walk(c, m)

    for ni in scene["nodes"]:
        walk(ni, np.eye(4))
    image = None
    for img in j.get("images", []):
        if "bufferView" in img:
            bv = j["bufferViews"][img["bufferView"]]
            import io
            from PIL import Image
            image = Image.open(io.BytesIO(blob[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]]))
            break
    return (np.concatenate(P).astype(np.float32), np.concatenate(T).astype(np.float32),
            np.concatenate(N).astype(np.float32), np.concatenate(F), image)


# ---------------------------------------------------------------- encoding
def orient_normals(pos, nrm, tris):
    """Normals that agree with the triangle winding (the game draws the side where the corners run
    counter-clockwise; its own models have their normals on that side). Missing or flipped normals
    are replaced by the area-weighted normal of the triangles around the vertex."""
    face = np.cross(pos[tris[:, 1]] - pos[tris[:, 0]], pos[tris[:, 2]] - pos[tris[:, 0]])
    acc = np.zeros_like(pos)
    for k in range(3):
        np.add.at(acc, tris[:, k], face)
    acc /= np.maximum(np.linalg.norm(acc, axis=1, keepdims=True), 1e-12)
    n = nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    bad = (np.linalg.norm(nrm, axis=1) < 1e-6) | ((n * acc).sum(1) < 0)
    n[bad] = acc[bad]
    return n.astype(np.float32)


def tangents(pos, uv, nrm, tris):
    """Unit tangents with handedness (+1/-1). A zero tangent made the game skip the whole mesh,
    so every vertex gets a valid one."""
    t = np.zeros_like(pos, dtype=np.float64)
    b = np.zeros_like(pos, dtype=np.float64)
    p0, p1, p2 = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    w0, w1, w2 = uv[tris[:, 0]], uv[tris[:, 1]], uv[tris[:, 2]]
    e1, e2, d1, d2 = p1 - p0, p2 - p0, w1 - w0, w2 - w0
    det = d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]
    r = np.where(np.abs(det) < 1e-12, 0.0, 1.0 / np.where(np.abs(det) < 1e-12, 1.0, det))
    tt = (e1 * d2[:, 1:2] - e2 * d1[:, 1:2]) * r[:, None]
    bb = (e2 * d1[:, 0:1] - e1 * d2[:, 0:1]) * r[:, None]
    for k in range(3):
        np.add.at(t, tris[:, k], tt)
        np.add.at(b, tris[:, k], bb)
    t -= nrm * (t * nrm).sum(1, keepdims=True)
    ln = np.linalg.norm(t, axis=1, keepdims=True)
    # fallback: any direction perpendicular to the normal
    ref = np.where(np.abs(nrm[:, 1:2]) < 0.9, np.array([[0.0, 1.0, 0.0]]), np.array([[1.0, 0.0, 0.0]]))
    fb = np.cross(nrm, ref)
    fb /= np.maximum(np.linalg.norm(fb, axis=1, keepdims=True), 1e-9)
    t = np.where(ln > 1e-6, t / np.maximum(ln, 1e-9), fb)
    w = np.where((np.cross(nrm, t) * b).sum(1) < 0, -1.0, 1.0)
    return t.astype(np.float32), w


def encode_vertices(pos, uv, nrm, tris, w_word):
    scale = float(np.abs(pos).max()) or 1.0
    nrm = nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-6)
    tan, hand = tangents(pos, uv, nrm, tris)
    out = np.zeros(len(pos), dtype=[("p", "<i2", 4), ("n", "i1", 4), ("t", "i1", 4), ("uv", "<f2", 2)])
    out["p"][:, :3] = np.round(pos / scale * 32767).astype(np.int16)
    out["p"][:, 3] = w_word
    out["n"][:, :3] = np.round(nrm * 127).astype(np.int8)
    out["t"][:, :3] = np.round(tan * 127).astype(np.int8)
    out["t"][:, 3] = np.where(hand < 0, -127, 127).astype(np.int8)
    out["uv"] = uv.astype(np.float16)
    return out.tobytes(), scale


def fit(pos, height):
    """Stand the mesh on the ground (y up, D2R uses y as height) and scale it to `height` units."""
    lo, hi = pos.min(0), pos.max(0)
    size = hi[1] - lo[1]
    s = height / size if size > 0 else 1.0
    out = (pos - [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]) * s
    return out.astype(np.float32)


# ---------------------------------------------------------------- the import
def build(template_raw, pos, uv, nrm, tris, group_sizes=None):
    """group_sizes: triangle count per material group of the template (default: split evenly, since
    the game skipped a mesh whose second group had no triangles)."""
    gf = GrannyFile(template_raw)
    g = gf.g
    mesh_t, _, meshes_a = gf.field(g.root_type, g.root_obj, "Meshes")
    meshes_d = _
    count, arr = g.u32(meshes_a), g.ptr(meshes_a + 4)
    if count != 1:
        raise ValueError("template must have one mesh")
    mesh = g.ptr(arr)
    # vertices
    _, vd_type, vd_field = gf.field(meshes_d, mesh, "PrimaryVertexData")
    vd = g.ptr(vd_field)
    _, _, verts = gf.field(vd_type, vd, "Vertices")
    vtype, old_count, old_ptr = g.ptr(verts), g.u32(verts + 8), g.ptr(verts + 12)
    if g.type_size(vtype) != 20:
        raise ValueError("unexpected vertex layout")
    sec_v, off_v = gf.loc(old_ptr)
    w_word = struct.unpack_from("<h", gf.data[sec_v], off_v + 6)[0]
    vbytes, scale = encode_vertices(pos, uv, nrm, tris, w_word)
    new_off = gf.append(sec_v, vbytes)
    gf.put(verts + 8, "I", len(pos))
    gf.point(verts + 12, sec_v, new_off)
    # triangles
    _, top_type, top_field = gf.field(meshes_d, mesh, "PrimaryTopology")
    top = g.ptr(top_field)
    _, _, i16 = gf.field(top_type, top, "Indices16")
    _, _, i32 = gf.field(top_type, top, "Indices")
    sec_i, _o = gf.loc(g.ptr(i16 + 4)) if g.u32(i16) else (sec_v, 0)
    if len(pos) < 65536:
        off = gf.append(sec_i, tris.astype("<u2").tobytes())
        gf.put(i16, "I", tris.size)
        gf.point(i16 + 4, sec_i, off)
        gf.put(i32, "I", 0)
    else:
        off = gf.append(sec_i, tris.astype("<u4").tobytes())
        gf.put(i32, "I", tris.size)
        gf.point(i32 + 4, sec_i, off)
        gf.put(i16, "I", 0)
    _, grp_type, groups_field = gf.field(top_type, top, "Groups")
    gcount, gptr = g.u32(groups_field), g.ptr(groups_field + 4)
    gsize = g.type_size(grp_type)
    groups = group_sizes or [len(tris) // gcount + (1 if k < len(tris) % gcount else 0) for k in range(gcount)]
    start = 0
    for k in range(gcount):
        _, _, first = gf.field(grp_type, gptr + k * gsize, "TriFirst")
        _, _, tcount = gf.field(grp_type, gptr + k * gsize, "TriCount")
        gf.put(first, "i", start)
        gf.put(tcount, "i", groups[k])
        start += groups[k]
    # bounds and vertex scale
    lo, hi = pos.min(0).tolist(), pos.max(0).tolist()
    _, _, ext_field = gf.field(meshes_d, mesh, "ExtendedData")
    ext_type, ext = g.ptr(ext_field), g.ptr(ext_field + 8)
    for name, val in (("bbMin", lo), ("bbMax", hi)):
        _, _, a = gf.field(ext_type, ext, name)
        gf.put(a, "3f", *val)
    _, _, a = gf.field(ext_type, ext, "VertexScale")
    gf.put(a, "f", scale)
    _, bb_type, bb = gf.field(meshes_d, mesh, "BoneBindings")
    bsize = g.type_size(bb_type)
    for k in range(g.u32(bb)):
        b = g.ptr(bb + 4) + k * bsize
        for name, val in (("OBBMin", lo), ("OBBMax", hi)):
            _, _, a = gf.field(bb_type, b, name)
            gf.put(a, "3f", *val)
    return gf, (lo, hi)


def import_mesh(src, new_model, read_asset, write_asset, read_current, texture_image=None, height=8.0,
                template=TEMPLATE):
    """Write <new_model without .model>_lod0..4.model, its texture and its model list entry."""
    if not re.fullmatch(r"data/hd/env/model/[a-z0-9_/]+\.model", new_model):
        raise ValueError("model path: data/hd/env/model/<folders>/<name>.model in lower case")
    if str(src).lower().endswith(".glb"):
        pos, uv, nrm, tris, embedded = read_glb(src)
        texture_image = texture_image or embedded
    else:
        pos, uv, nrm, tris = read_obj(src)
    pos = fit(pos, height)
    nrm = orient_normals(pos, nrm, tris)
    uv = uv.copy()
    uv[:, 1] = 1.0 - uv[:, 1]  # glTF/OBJ: v up; Granny: v down
    base = new_model[:-len(".model")]
    tag = re.sub(r"[^a-z0-9]", "", pathlib.Path(base).name)[:4].ljust(4, "x")
    template_raw = read_asset(f"{template}_lod0.model")
    gf, bounds = build(template_raw, pos, uv, nrm, tris)
    # textures: every albedo of the template becomes the new model's texture
    replace = {}
    for p in retexture.albedo_paths(template_raw):
        q = retexture.new_texture_path(p, tag)
        replace[p.encode()] = q.encode()
        if texture_image is not None:
            img = texture_image.convert("RGBA").resize((1024, 1024))
        else:
            img = texture.read_rgba(read_asset(p))
        write_asset(q, texture.write_texture(img))
    for sec, d in enumerate(gf.data):
        for old, new in replace.items():
            gf.data[sec] = d = d.replace(old + b"\0", new + b"\0")
    # One LOD only: the game checks each LOD file against the template's LOD data and skips the
    # model when a file does not fit (e.g. the full mesh in a lower LOD), so the entry gets one LOD.
    write_asset(f"{base}_lod0.model", gf.to_bytes())
    data = retexture.lod_bin_add(read_current(retexture.LOD_BIN), {new_model: f"{template}.model"})
    write_asset(retexture.LOD_BIN, set_entry(data, new_model, *bounds))
    return new_model, len(pos), len(tris)


def set_entry(data, path, lo, hi):
    """Bounds of the model list entry, and one LOD (flags bit 1 = LOD 0, then the LOD count)."""
    count, rel = struct.unpack_from("<Ii", data, 0)
    start, h = 4 + rel, retexture.fnv1a(path)
    out = bytearray(data)
    for k in range(count):
        pos = start + k * retexture.ENTRY
        if struct.unpack_from("<I", out, pos)[0] == h:
            struct.pack_into("<6f", out, pos + 4, *lo, *hi)
            flags = struct.unpack_from("<I", out, pos + 28)[0]
            struct.pack_into("<II", out, pos + 28, (flags & ~0xFF) | 0x02, 1)
            return bytes(out)
    raise KeyError(path)


def main():
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
    import server  # noqa: PLC0415
    from PIL import Image
    src, new = sys.argv[1], sys.argv[2]
    tex = Image.open(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != "-" else None
    height = float(sys.argv[4]) if len(sys.argv) > 4 else 8.0

    def write(path, data):
        dst = server.PROJECT / path
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
    print(import_mesh(src, new, lambda p: server.read_asset(p, original=True), write, server.read_asset, tex, height))


if __name__ == "__main__":
    main()
