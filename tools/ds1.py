"""Read and write Diablo II .ds1 map presets (legacy layer that drives gameplay collision).

Layout (versions 18+ as used by D2R):
  i32 version, i32 width-1, i32 height-1, i32 act (v>=8), i32 tagType (v>=10)
  i32 fileCount + NUL-terminated names (v>=3)
  (v 9..13: 8 unknown bytes)
  i32 wallLayers (v>=4), i32 floorLayers (v>=16, else 1)
  cell layers, each width*height u32, in this order:
    for each wall layer: wall, orientation     (v>=4)
    floor layers, shadow layer, tag layer (only when tagType is 1 or 2)
  then objects, groups, npc paths: kept as an opaque tail and written back unchanged.

Cell (wall/floor):  bits 0-7 prop1, 8-13 sub index (sequence), 20-25 main index, 31 hidden.
Orientation cell: low byte = orientation (wall tiles); floors use orientation 0.

  python -I ds1.py info <file.ds1>
"""
import struct
import sys


class DS1:
    def __init__(self, data):
        self.raw = data
        o = 0

        def i32():
            nonlocal o
            v = struct.unpack_from("<i", data, o)[0]
            o += 4
            return v

        self.version = i32()
        self.width = i32() + 1
        self.height = i32() + 1
        self.act = i32() if self.version >= 8 else 0
        self.tag_type = i32() if self.version >= 10 else 0
        self.files = []
        if self.version >= 3:
            for _ in range(i32()):
                e = data.index(b"\0", o)
                self.files.append(data[o:e].decode("latin1"))
                o = e + 1
        if 9 <= self.version <= 13:
            o += 8
        self.wall_layers = i32() if self.version >= 4 else 1
        self.floor_layers = i32() if self.version >= 16 else 1
        self.head_end = o
        n = self.width * self.height
        layers = []
        for i in range(self.wall_layers):
            layers.append(("wall", i))
            layers.append(("orient", i))
        for i in range(self.floor_layers):
            layers.append(("floor", i))
        layers.append(("shadow", 0))
        if self.tag_type in (1, 2):
            layers.append(("tag", 0))
        self.layers = {}
        for key in layers:
            self.layers[key] = list(struct.unpack_from(f"<{n}I", data, o))
            o += 4 * n
        self.layer_order = layers
        self.tail = data[o:]

    def cell(self, kind, layer, x, y):
        return self.layers[(kind, layer)][y * self.width + x]

    def set_cell(self, kind, layer, x, y, value):
        self.layers[(kind, layer)][y * self.width + x] = value

    def add_wall_layer(self):
        """Append an empty wall layer (max 4). Returns its index."""
        if self.wall_layers >= 4:
            raise ValueError("DS1 already has 4 wall layers")
        idx = self.wall_layers
        n = self.width * self.height
        self.wall_layers += 1
        order = []
        for i in range(self.wall_layers):
            order += [("wall", i), ("orient", i)]
        order += [k for k in self.layer_order if k[0] not in ("wall", "orient")]
        self.layers[("wall", idx)] = [0] * n
        self.layers[("orient", idx)] = [0] * n
        self.layer_order = order
        return idx

    def add_floor_layer(self):
        """Append an empty floor layer (max 2, needs version >= 16). Returns its index."""
        if self.version < 16 or self.floor_layers >= 2:
            raise ValueError("cannot add a floor layer to this DS1")
        idx = self.floor_layers
        self.floor_layers += 1
        self.layers[("floor", idx)] = [0] * (self.width * self.height)
        pos = self.layer_order.index(("floor", idx - 1)) + 1
        self.layer_order.insert(pos, ("floor", idx))
        return idx

    def to_bytes(self):
        out = bytearray(self.raw[:self.head_end])
        # rewrite the layer count fields at the end of the header
        if self.version >= 16:
            struct.pack_into("<ii", out, self.head_end - 8, self.wall_layers, self.floor_layers)
        else:
            struct.pack_into("<i", out, self.head_end - 4, self.wall_layers)
        for key in self.layer_order:
            out += struct.pack(f"<{len(self.layers[key])}I", *self.layers[key])
        out += self.tail
        return bytes(out)


def decode_cell(v):
    return {"prop1": v & 0xFF, "sub": (v >> 8) & 0x3F, "main": (v >> 20) & 0x3F, "hidden": v >> 31}


def encode_cell(main, sub, prop1=1):
    return (prop1 & 0xFF) | ((sub & 0x3F) << 8) | ((main & 0x3F) << 20)


if __name__ == "__main__":
    d = DS1(open(sys.argv[2], "rb").read())
    print(f"version {d.version} size {d.width}x{d.height} tiles act {d.act} tagType {d.tag_type}")
    print("walls", d.wall_layers, "floors", d.floor_layers, "tail bytes", len(d.tail))
    print("files", d.files)
    assert d.to_bytes() == d.raw, "round trip failed"
    print("round trip ok")


class Ds1Objects:
    """Objects (NPCs, monsters, chests...) and NPC paths from a DS1 tail.

    Tail layout (version >= 2): i32 count, count x {i32 type, i32 id, i32 x, i32 y, i32 flags (v>5)}.
    Then groups (v>=12 and tagType 1/2) and NPC paths (v>=14): i32 count, per path
    {i32 nodes, i32 x, i32 y (coordinates of the NPC it belongs to), nodes x {i32 x, i32 y, i32 action (v>=15)}}.
    Groups: (v>=18: i32 padding) i32 count, count x {i32 x, i32 y, i32 width, i32 height, i32 unknown (v>=13)};
    they are kept as raw bytes. Positions are in subtiles. Editing is allowed only when writing
    back reproduces the file exactly.
    """

    def __init__(self, ds1):
        self.ds1 = ds1
        t, v = ds1.tail, ds1.version
        self.editable = v >= 2 and len(t) >= 4
        self.objects, self.paths, self.rest, self.groups = [], [], b"", b""
        if not self.editable:
            return
        o = 0
        n = struct.unpack_from("<i", t, o)[0]
        o += 4
        size = 20 if v > 5 else 16
        for _ in range(n):
            vals = struct.unpack_from("<iiiii" if size == 20 else "<iiii", t, o)
            o += size
            self.objects.append({"type": vals[0], "id": vals[1], "x": vals[2], "y": vals[3],
                                 "flags": vals[4] if size == 20 else 0})
        if v >= 12 and ds1.tag_type in (1, 2) and o < len(t):
            g0 = o
            if v >= 18:
                o += 4
            gc = struct.unpack_from("<i", t, o)[0]
            o += 4 + gc * (20 if v >= 13 else 16)
            self.groups = t[g0:o]
        if v >= 14 and o < len(t):
            pc = struct.unpack_from("<i", t, o)[0]
            o += 4
            per_node = 3 if v >= 15 else 2
            for _ in range(pc):
                nodes, x, y = struct.unpack_from("<iii", t, o)
                o += 12
                pts = [list(struct.unpack_from(f"<{per_node}i", t, o + k * 4 * per_node)) for k in range(nodes)]
                o += nodes * 4 * per_node
                self.paths.append({"x": x, "y": y, "nodes": pts})
        self.rest = t[o:]
        # only allow edits when writing back reproduces the file exactly
        if self.to_tail() != t or ds1.to_bytes() != ds1.raw:
            self.editable = False
            self.objects, self.paths = [], []

    def to_tail(self):
        v = self.ds1.version
        out = bytearray(struct.pack("<i", len(self.objects)))
        for ob in self.objects:
            if v > 5:
                out += struct.pack("<iiiii", ob["type"], ob["id"], ob["x"], ob["y"], ob.get("flags", 0))
            else:
                out += struct.pack("<iiii", ob["type"], ob["id"], ob["x"], ob["y"])
        out += self.groups
        if v < 14:  # no NPC paths before version 14
            return bytes(out) + self.rest
        out += struct.pack("<i", len(self.paths))
        for p in self.paths:
            out += struct.pack("<iii", len(p["nodes"]), p["x"], p["y"])
            for node in p["nodes"]:
                out += struct.pack(f"<{len(node)}i", *node)
        return bytes(out) + self.rest
