"""Reader for D2R HD .model files (Granny 3D, 64-bit little endian, BitKnit2 sections).

Granny files are self-describing: the root object comes with a type tree. This reader
decompresses every section, applies pointer fixups and walks the type tree into plain
Python dicts/lists (generic), so callers can pick out meshes, materials and skeletons.

  python -I gr2.py info <file.model>        print the object tree (shallow)
  python -I gr2.py dump <file.model> [depth]
"""
import ctypes
import pathlib
import struct
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
_bk = ctypes.CDLL(str(ROOT / "native" / "bitknit.dll"))
_bk.bitknit2_decompress.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint]
_bk.bitknit2_decompress.restype = ctypes.c_int

MAGIC_LE64 = bytes.fromhex("e59b495e6f631f141e13eba990beedc4")

# member types
T_NONE, T_INLINE, T_REF, T_REFARRAY, T_ARRAYOFREFS, T_VARREF, T_UNUSED6, T_REFVARARRAY, T_STRING, \
    T_TRANSFORM, T_REAL32, T_INT8, T_UINT8, T_BINORMAL_INT8, T_NORMAL_UINT8, T_INT16, T_UINT16, \
    T_BINORMAL_INT16, T_NORMAL_UINT16, T_INT32, T_UINT32, T_REAL16, T_EMPTYREF = range(23)
SCALAR = {T_REAL32: ("f", 4), T_INT8: ("b", 1), T_UINT8: ("B", 1), T_BINORMAL_INT8: ("b", 1),
          T_NORMAL_UINT8: ("B", 1), T_INT16: ("h", 2), T_UINT16: ("H", 2), T_BINORMAL_INT16: ("h", 2),
          T_NORMAL_UINT16: ("H", 2), T_INT32: ("i", 4), T_UINT32: ("I", 4), T_REAL16: ("e", 2)}
PTR = 8
MEMBER_SIZE = 44  # type u32, name ptr, definition ptr, array size u32, extra u32[3], unknown u64


def decompress(compression, data, size):
    if compression == 0:
        return bytes(data[:size])
    if compression != 4:
        raise NotImplementedError(f"Granny compression {compression}")
    out = ctypes.create_string_buffer(size)
    src = ctypes.create_string_buffer(bytes(data), len(data))
    if not _bk.bitknit2_decompress(src, len(data), out, size):
        raise ValueError("BitKnit2 decompression failed")
    return out.raw


class Granny:
    def __init__(self, data):
        if data[:16] != MAGIC_LE64:
            raise ValueError("not a little-endian 64-bit Granny file")
        info = 0x20
        (self.version, self.file_size, _crc, sec_off, sec_count,
         rt_sec, rt_off, rn_sec, rn_off) = struct.unpack_from("<9I", data, info)
        self.sections = []
        hdrs = []
        for i in range(sec_count):
            h = struct.unpack_from("<11I", data, info + sec_off + i * 44)
            hdrs.append(h)
            comp, doff, dsize, usize = h[:4]
            self.sections.append(bytearray(decompress(comp, data[doff:doff + dsize], usize)) if usize else bytearray())
        # pointer fixups: {u32 offset in section, u32 target section, u32 target offset}
        self.base = [0x1000_0000_0000 * (i + 1) for i in range(sec_count)]  # fake addresses per section
        for i, h in enumerate(hdrs):
            comp, fix_off, fix_count = h[0], h[7], h[8]
            if not fix_count:
                continue
            raw_len = fix_count * 12
            if comp:
                csize = struct.unpack_from("<I", data, fix_off)[0]
                table = decompress(comp, data[fix_off + 4:fix_off + 4 + csize], raw_len)
            else:
                table = data[fix_off:fix_off + raw_len]
            sec = self.sections[i]
            for k in range(fix_count):
                src, tsec, toff = struct.unpack_from("<III", table, k * 12)
                struct.pack_into("<Q", sec, src, self.base[tsec] + toff)
        self.root_type = self.base[rt_sec] + rt_off
        self.root_obj = self.base[rn_sec] + rn_off
        self._cache = {}

    # -- address helpers --
    def loc(self, addr):
        for i, b in enumerate(self.base):
            if b <= addr < b + 0x1000_0000_0000:
                return self.sections[i], addr - b
        raise ValueError(f"bad address {addr:#x}")

    def u32(self, addr):
        s, o = self.loc(addr)
        return struct.unpack_from("<I", s, o)[0]

    def ptr(self, addr):
        s, o = self.loc(addr)
        return struct.unpack_from("<Q", s, o)[0]

    def cstr(self, addr):
        if not addr:
            return None
        s, o = self.loc(addr)
        e = s.index(0, o)
        return s[o:e].decode("utf-8", "replace")

    # -- type tree --
    def members(self, type_addr):
        out = []
        a = type_addr
        while True:
            t = self.u32(a)
            if t == T_NONE:
                break
            name = self.cstr(self.ptr(a + 4))
            definition = self.ptr(a + 12)
            count = self.u32(a + 20)
            out.append((t, name, definition, count))
            a += MEMBER_SIZE
        return out

    def type_size(self, type_addr):
        size = 0
        for t, _, d, n in self.members(type_addr):
            size += self.member_size(t, d) * max(n, 1)
        return size

    def member_size(self, t, d):
        if t == T_INLINE:
            return self.type_size(d)
        if t in (T_REF, T_STRING, T_EMPTYREF):
            return PTR
        if t in (T_REFARRAY, T_ARRAYOFREFS):
            return 4 + PTR
        if t == T_VARREF:
            return 2 * PTR
        if t == T_REFVARARRAY:
            return PTR + 4 + PTR
        if t == T_TRANSFORM:
            return 4 + 12 + 16 + 36
        return SCALAR[t][1]

    # -- object reader --
    def read(self, type_addr, addr, depth=64):
        if not addr or depth < 0:
            return None
        key = (type_addr, addr)
        if key in self._cache:
            return self._cache[key]
        obj = {}
        self._cache[key] = obj
        a = addr
        for t, name, d, n in self.members(type_addr):
            msize = self.member_size(t, d)
            if n:
                obj[name] = [self._value(t, d, a + i * msize, depth) for i in range(n)]
            else:
                obj[name] = self._value(t, d, a, depth)
            a += msize * max(n, 1)
        return obj

    def _value(self, t, d, a, depth):
        if t in SCALAR:
            fmt, size = SCALAR[t]
            s, o = self.loc(a)
            return struct.unpack_from("<" + fmt, s, o)[0]
        if t == T_INLINE:
            return self.read(d, a, depth - 1)
        if t == T_STRING:
            return self.cstr(self.ptr(a))
        if t == T_REF:
            return self.read(d, self.ptr(a), depth - 1)
        if t == T_EMPTYREF:
            return None
        if t == T_REFARRAY:
            count, p = self.u32(a), self.ptr(a + 4)
            if not p or not count:
                return []
            es = self.type_size(d)
            return ArrayRef(self, d, p, count, es, depth - 1)
        if t == T_ARRAYOFREFS:
            count, p = self.u32(a), self.ptr(a + 4)
            return [self.read(d, self.ptr(p + i * PTR), depth - 1) for i in range(count)] if p else []
        if t == T_VARREF:
            vt, p = self.ptr(a), self.ptr(a + PTR)
            return self.read(vt, p, depth - 1) if vt else None
        if t == T_REFVARARRAY:
            vt, count, p = self.ptr(a), self.u32(a + PTR), self.ptr(a + PTR + 4)
            if not vt or not p or not count:
                return []
            return ArrayRef(self, vt, p, count, self.type_size(vt), depth - 1)
        if t == T_TRANSFORM:
            s, o = self.loc(a)
            v = struct.unpack_from("<I3f4f9f", s, o)
            return {"flags": v[0], "position": v[1:4], "orientation": v[4:8], "scale_shear": v[8:17]}
        raise NotImplementedError(t)

    def root(self):
        return self.read(self.root_type, self.root_obj)


class ArrayRef:
    """Lazy array of structs; raw() gives the packed bytes for fast vertex/index access."""

    def __init__(self, g, type_addr, addr, count, elem_size, depth):
        self.g, self.type_addr, self.addr, self.count, self.elem_size, self.depth = \
            g, type_addr, addr, count, elem_size, depth

    def __len__(self):
        return self.count

    def __getitem__(self, i):
        if isinstance(i, slice):
            return [self[j] for j in range(*i.indices(self.count))]
        if i < 0:
            i += self.count
        return self.g.read(self.type_addr, self.addr + i * self.elem_size, self.depth)

    def __iter__(self):
        for i in range(self.count):
            yield self[i]

    def layout(self):
        return [(name, t, n) for t, name, d, n in self.g.members(self.type_addr)]

    def raw(self):
        s, o = self.g.loc(self.addr)
        return bytes(s[o:o + self.count * self.elem_size])

    def __repr__(self):
        return f"<array {self.count} x {self.elem_size}B {[m[0] for m in self.layout()]}>"


def show(obj, depth, indent=0):
    pad = "  " * indent
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (dict, list, ArrayRef)) and depth > 0:
                print(f"{pad}{k}:" + (f" {v!r}" if isinstance(v, ArrayRef) else ""))
                if not isinstance(v, ArrayRef):
                    show(v, depth - 1, indent + 1)
                elif len(v) and depth > 1:
                    show(v[0], depth - 2, indent + 2)
            else:
                r = repr(v) if not isinstance(v, (dict, list)) else f"<{type(v).__name__} {len(v)}>"
                print(f"{pad}{k}: {r[:120]}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj[:6]):
            print(f"{pad}[{i}]")
            show(v, depth - 1, indent + 1)
        if len(obj) > 6:
            print(f"{pad}... {len(obj)} items")
    else:
        print(f"{pad}{obj!r}"[:140])


if __name__ == "__main__":
    g = Granny(open(sys.argv[2], "rb").read())
    print("version", g.version, "sections", len(g.sections), [len(s) for s in g.sections])
    show(g.root(), int(sys.argv[3]) if len(sys.argv) > 3 else 3)
