"""Convert a D2R HD .model (Granny) into a binary glTF (GLB) for the editor.

Vertex decoding (verified on act1 palisade):
  Position  BinormalInt16 x4: xyz / 32767 * mesh.ExtendedData.VertexScale (w is unused here)
            Real32 x3: as is
  Normal    BinormalInt8 x4: xyz / 127
  TextureCoordinates0  Real16/Real32 x2
  DiffuseColor0  NormalUInt8 x4 (vertex colour)
Each Granny model has an InitialPlacement transform; its meshes become glTF nodes with it.
Materials: Maps with Usage AlbedoTexture -> Map.Texture.FromFileName. The GLB references
textures by URI /api/texture?path=<path>, served by the editor server as PNG.

  python -I model_export.py <in.model> <out.glb>
"""
import json
import struct
import sys
import urllib.parse

import os

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gr2 import Granny, ArrayRef, T_BINORMAL_INT16, T_BINORMAL_INT8, T_NORMAL_UINT8, T_REAL16, \
    T_REAL32, T_INT16, T_UINT16, T_NORMAL_UINT16, T_INT8, T_UINT8, T_INT32, T_UINT32  # noqa: E402

NP = {T_REAL32: "<f4", T_REAL16: "<f2", T_BINORMAL_INT16: "<i2", T_INT16: "<i2", T_UINT16: "<u2",
      T_NORMAL_UINT16: "<u2", T_BINORMAL_INT8: "i1", T_INT8: "i1", T_UINT8: "u1", T_NORMAL_UINT8: "u1",
      T_INT32: "<i4", T_UINT32: "<u4"}


def vertex_array(arr):
    fields = []
    for name, t, n in arr.layout():
        fields.append((name, NP[t], (max(n, 1),)))
    dt = np.dtype(fields)
    assert dt.itemsize == arr.elem_size, (dt.itemsize, arr.elem_size)
    return np.frombuffer(arr.raw(), dtype=dt), {name: t for name, t, n in arr.layout()}


def decode_positions(v, types, ext):
    p = v["Position"].astype(np.float32)
    if types["Position"] == T_BINORMAL_INT16:
        scale = float((ext or {}).get("VertexScale") or 1.0)
        p = p[:, :3] / 32767.0 * scale
    return np.ascontiguousarray(p[:, :3], dtype=np.float32)


def decode_normals(v, types):
    if "Normal" not in types:
        return None
    n = v["Normal"].astype(np.float32)[:, :3]
    t = types["Normal"]
    if t == T_BINORMAL_INT8:
        n /= 127.0
    elif t == T_BINORMAL_INT16:
        n /= 32767.0
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln == 0] = 1
    return np.ascontiguousarray(n / ln, dtype=np.float32)


def decode_uv(v, types):
    if "TextureCoordinates0" not in types:
        return None
    return np.ascontiguousarray(v["TextureCoordinates0"].astype(np.float32)[:, :2])


def texture_of(material, usage="AlbedoTexture", seen=None):
    if not material:
        return None
    for m in material.get("Maps") or []:
        if m.get("Usage") == usage and m.get("Map"):
            tex = m["Map"].get("Texture")
            if tex and tex.get("FromFileName"):
                return tex["FromFileName"]
    tex = material.get("Texture")
    return tex.get("FromFileName") if tex else None


def is_water(material):
    if not material:
        return False
    usages = {m.get("Usage") for m in material.get("Maps") or []}
    name = (material.get("Name") or "").lower()
    return "FoamMaskTexture" in usages or any(w in name for w in ("water", "river", "pond", "lake"))


def mat_from_scale_shear(t):
    pos, q, ss = t["position"], t["orientation"], t["scale_shear"]
    x, y, z, w = q
    rot = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]], dtype=np.float64)
    m3 = rot @ np.array(ss, dtype=np.float64).reshape(3, 3)
    m = np.eye(4)
    m[:3, :3] = m3
    m[:3, 3] = pos
    return m


class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.j = {"asset": {"version": "2.0", "generator": "d2r-editor"}, "buffers": [], "bufferViews": [],
                  "accessors": [], "meshes": [], "nodes": [], "materials": [], "textures": [], "images": [],
                  "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
                  "scenes": [{"nodes": []}], "scene": 0}
        self.mat_index = {}

    def add(self, arr, target, ctype, typ, minmax=False):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += arr.tobytes()
        self.j["bufferViews"].append({"buffer": 0, "byteOffset": off, "byteLength": arr.nbytes, "target": target})
        acc = {"bufferView": len(self.j["bufferViews"]) - 1, "componentType": ctype,
               "count": int(arr.shape[0]), "type": typ}
        if minmax:
            acc["min"] = arr.min(axis=0).tolist()
            acc["max"] = arr.max(axis=0).tolist()
        self.j["accessors"].append(acc)
        return len(self.j["accessors"]) - 1

    def material(self, tex_path, name, water=False):
        key = tex_path or f"none:{name}:{water}"
        if key in self.mat_index:
            return self.mat_index[key]
        mat = {"name": name or "material", "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.9},
               "alphaMode": "MASK", "alphaCutoff": 0.4, "doubleSided": True}
        if tex_path:
            # relative URI: resolved against /api/model -> /api/texture
            # lower case: game files name the same texture in different cases, the browser loads it once
            self.j["images"].append({"uri": "texture?path=" + urllib.parse.quote(tex_path.replace("\\", "/").lower())})
            self.j["textures"].append({"sampler": 0, "source": len(self.j["images"]) - 1})
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(self.j["textures"]) - 1}
        elif water:
            # water shaders have no albedo (normal + foam masks only): translucent blue-green
            mat["pbrMetallicRoughness"].update(baseColorFactor=[0.16, 0.30, 0.34, 0.72], roughnessFactor=0.15)
            mat["alphaMode"] = "BLEND"
            mat.pop("alphaCutoff", None)
        else:
            mat["pbrMetallicRoughness"]["baseColorFactor"] = [0.6, 0.6, 0.6, 1.0]
        self.j["materials"].append(mat)
        self.mat_index[key] = len(self.j["materials"]) - 1
        return self.mat_index[key]

    def finish(self):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.j["buffers"].append({"byteLength": len(self.bin)})
        for k in ("textures", "images"):
            if not self.j[k]:
                del self.j[k]
        js = json.dumps(self.j, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(self.bin))
        out += struct.pack("<II", len(js), 0x4E4F534A) + js
        out += struct.pack("<II", len(self.bin), 0x004E4942) + bytes(self.bin)
        return out


def convert(data):
    g = Granny(data)
    root = g.root()
    glb = GLB()
    mesh_index = {}
    for mesh in root.get("Meshes") or []:
        vd = mesh.get("PrimaryVertexData")
        if not vd or not isinstance(vd.get("Vertices"), ArrayRef) or not len(vd["Vertices"]):
            continue
        v, types = vertex_array(vd["Vertices"])
        pos = decode_positions(v, types, mesh.get("ExtendedData"))
        nrm = decode_normals(v, types)
        uv = decode_uv(v, types)
        top = mesh["PrimaryTopology"]
        idx16, idx32 = top.get("Indices16"), top.get("Indices")
        if isinstance(idx16, ArrayRef) and len(idx16):
            indices = np.frombuffer(idx16.raw(), dtype="<u2").astype(np.uint32)
        elif isinstance(idx32, ArrayRef) and len(idx32):
            indices = np.frombuffer(idx32.raw(), dtype="<u4").astype(np.uint32)
        else:
            continue
        attrs = {"POSITION": glb.add(pos, 34962, 5126, "VEC3", minmax=True)}
        if nrm is not None:
            attrs["NORMAL"] = glb.add(nrm, 34962, 5126, "VEC3")
        if uv is not None:
            attrs["TEXCOORD_0"] = glb.add(uv, 34962, 5126, "VEC2")
        prims = []
        bindings = mesh.get("MaterialBindings") or []
        groups = list(top.get("Groups") or []) or [{"MaterialIndex": 0, "TriFirst": 0, "TriCount": len(indices) // 3}]
        for grp in groups:
            tri = indices[grp["TriFirst"] * 3:(grp["TriFirst"] + grp["TriCount"]) * 3]
            if not len(tri):
                continue
            mi = grp["MaterialIndex"]
            mat = bindings[mi]["Material"] if mi < len(bindings) and bindings[mi] else None
            prims.append({"attributes": attrs, "indices": glb.add(np.ascontiguousarray(tri), 34963, 5125, "SCALAR"),
                          "material": glb.material(texture_of(mat), (mat or {}).get("Name"), is_water(mat))})
        if prims:
            glb.j["meshes"].append({"name": mesh.get("Name"), "primitives": prims})
            mesh_index[id(mesh)] = len(glb.j["meshes"]) - 1
    # one node per Granny model placement, children per bound mesh
    placed = set()
    for model in root.get("Models") or []:
        m = mat_from_scale_shear(model["InitialPlacement"]) if model.get("InitialPlacement") else np.eye(4)
        for mb in model.get("MeshBindings") or []:
            mesh = mb.get("Mesh")
            if mesh is None or id(mesh) not in mesh_index:
                continue
            placed.add(id(mesh))
            glb.j["nodes"].append({"name": model.get("Name"), "mesh": mesh_index[id(mesh)],
                                   "matrix": m.T.flatten().tolist()})
            glb.j["scenes"][0]["nodes"].append(len(glb.j["nodes"]) - 1)
    for mesh in root.get("Meshes") or []:
        if id(mesh) in mesh_index and id(mesh) not in placed:
            glb.j["nodes"].append({"name": mesh.get("Name"), "mesh": mesh_index[id(mesh)]})
            glb.j["scenes"][0]["nodes"].append(len(glb.j["nodes"]) - 1)
    return glb.finish()


if __name__ == "__main__":
    out = convert(open(sys.argv[1], "rb").read())
    open(sys.argv[2], "wb").write(out)
    print("written", sys.argv[2], len(out), "bytes")
