"""Animated D2R characters as binary glTF: skinned meshes, the skeleton and the animations.

A character is a JSON file (data/hd/character/<group>/<name>.json) naming its models (e.g.
torso.model) and its skeleton (<name>/skeleton/<name>.skeleton). Its animations are in
<name>/animation/combined.animations, all Granny files.

Skeleton: bones with ParentIndex, a local Transform (position, orientation x y z w, 3x3
scale/shear) and InverseWorldTransform (4x4, translation in the last row: the same memory
layout as a glTF column-major matrix), used as the inverse bind matrix.

Skinning: vertices carry BoneIndices (into the mesh's BoneBindings, matched to skeleton bones by
name) and BoneWeights (NormalUInt8, sum 255).

Animations: one track group per animation with a transform track per bone name and three curves
(orientation, position, scale/shear). Curve formats (Granny; decoding as in LSLib, Norbyte, MIT):
  DaIdentity, DaConstant32f, D3Constant32f, D4Constant32f, DaKeyframes32f, DaK32fC32f
  D3K16uC16u / D3K8uC8u           knots + 3 quantized controls per knot (scale, offset per axis)
  D3I1K16uC16u / D3I1K8uC8u       knots + 1 control per knot, used for all three axes
  D9I1K16uC16u / D9I1K8uC8u       uniform scale; D9I3K16uC16u / D9I3K8uC8u: scale per axis
  D4nK16uC15u / D4nK8uC7u         normalized quaternions with 3 stored components (see quat())
Knots of the quantized formats: value / OneOverKnotScale; "Trunc" scales are the upper 16 bits of
a float. The curves are splines (degree 2); the editor plays their control points as keyframes
(linear), which is close enough to see the motion.
"""
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model_export as me  # noqa: E402
from gr2 import Granny, ArrayRef  # noqa: E402

SCALE_TABLE = [1.4142135, 0.70710677, 0.35355338, 0.35355338, 0.35355338, 0.17677669, 0.17677669, 0.17677669,
               -1.4142135, -0.70710677, -0.35355338, -0.35355338, -0.35355338, -0.17677669, -0.17677669, -0.17677669]
OFFSET_TABLE = [-0.70710677, -0.35355338, -0.53033006, -0.17677669, 0.17677669, -0.17677669, -0.088388346, 0.0,
                0.70710677, 0.35355338, 0.53033006, 0.17677669, -0.17677669, 0.17677669, 0.088388346, -0.0]


def trunc_scale(v):
    return struct.unpack("<f", struct.pack("<I", (v & 0xFFFF) << 16))[0]


def raw(arr, dtype):
    if isinstance(arr, ArrayRef):
        return np.frombuffer(arr.raw(), dtype=dtype).astype(np.float64)
    return np.array(list(arr or []), dtype=np.float64)


def quats(kc, n, selector, bits):
    """Quaternions of D4nK16uC15u (bits 16) and D4nK8uC7u (bits 8): three stored components and
    the fourth from the unit length; two high bits choose which one is left out."""
    mul = 1 / 32767 if bits == 16 else 1 / 127
    hi, mask = (0x8000, 0x7FFF) if bits == 16 else (0x80, 0x7F)
    scales = [SCALE_TABLE[(selector >> (4 * i)) & 15] * mul for i in range(4)]
    offsets = [OFFSET_TABLE[(selector >> (4 * i)) & 15] for i in range(4)]
    out = np.zeros((n, 4))
    c = kc[n:].astype(np.int64)
    for i in range(n):
        a, b, cc = int(c[3 * i]), int(c[3 * i + 1]), int(c[3 * i + 2])
        s1 = (((b & hi) >> (14 if bits == 16 else 6)) | ((cc & hi) >> (15 if bits == 16 else 7))) & 3
        s2, s3, s4 = (s1 + 1) & 3, (s1 + 2) & 3, (s1 + 3) & 3
        da = (a & mask) * scales[s2] + offsets[s2]
        db = (b & mask) * scales[s3] + offsets[s3]
        dc = (cc & mask) * scales[s4] + offsets[s4]
        dd = np.sqrt(max(0.0, 1 - (da * da + db * db + dc * dc)))
        if a & hi:
            dd = -dd
        q = [0.0] * 4
        q[s2], q[s3], q[s4], q[s1] = da, db, dc, dd
        out[i] = q
    return out


def curve(cd, kind):
    """(times, values) of a curve; kind 'O' -> quaternions (x y z w), 'P' -> vec3, 'S' -> 3x3 diagonal
    (scale x y z). None for an identity curve (the bone's rest value is used)."""
    if not cd:
        return None
    name = next((k for k in cd if k.startswith("CurveDataHeader_")), "")[len("CurveDataHeader_"):]
    if name == "DaIdentity":
        return None
    if name in ("D3Constant32f", "D4Constant32f", "DaConstant32f"):
        v = raw(cd["Controls"], "<f4")
        return np.zeros(1), v[None, :]
    if name in ("DaK32fC32f", "DaKeyframes32f"):
        if name == "DaKeyframes32f":
            dim = cd["Dimension"]
            v = raw(cd["Controls"], "<f4").reshape(-1, dim)
            return np.arange(len(v)) / 30.0, v
        t = raw(cd["Knots"], "<f4")
        v = raw(cd["Controls"], "<f4")
        return t, v.reshape(len(t), -1)
    u16 = "K16u" in name
    kc = raw(cd["KnotsControls"], "<u2" if u16 else "u1")
    if name.startswith("D4n"):
        n = len(kc) // 4
        return kc[:n] / cd["OneOverKnotScale"], quats(kc, n, cd["ScaleOffsetTableEntries"], 16 if u16 else 8)
    per = 1 if ("I1" in name) else 3
    n = len(kc) // (1 + per)
    times = kc[:n] / trunc_scale(cd["OneOverKnotScaleTrunc"])
    c = kc[n:].reshape(n, per)
    if name.startswith("D9I1"):
        s = c[:, 0] * cd["ControlScale"] + cd["ControlOffset"]
        return times, np.stack([s, s, s], axis=1)
    sc, of = np.array(cd["ControlScales"], np.float64), np.array(cd["ControlOffsets"], np.float64)
    if per == 1:
        return times, c[:, :1] * sc[None, :] + of[None, :]
    return times, c * sc[None, :] + of[None, :]


def scale_of(values, kind):
    """A 3x3 scale/shear (9 values) or diagonal (3 values) as a scale vector."""
    if values.shape[1] == 9:
        return values[:, [0, 4, 8]]
    return values


def bone_trs(t):
    ss = t["scale_shear"]
    return list(t["position"]), list(t["orientation"]), [ss[0], ss[4], ss[8]]


def build(models_raw, skeleton_raw, anims_raw, wanted=None):
    """GLB of a character. wanted: animation names to include (None: all but additive ones)."""
    glb = me.GLB()
    j = glb.j
    sk = Granny(skeleton_raw).root()["Skeletons"][0]
    bones = list(sk["Bones"])
    bone_index = {b["Name"]: i for i, b in enumerate(bones)}
    # nodes for the bones
    first = len(j["nodes"])
    for b in bones:
        p, q, s = bone_trs(b["Transform"])
        j["nodes"].append({"name": b["Name"], "translation": p, "rotation": q, "scale": s})
    roots = []
    for i, b in enumerate(bones):
        pi = b["ParentIndex"]
        if 0 <= pi < len(bones) and pi != i:
            j["nodes"][first + pi].setdefault("children", []).append(first + i)
        else:
            roots.append(first + i)
    ibm = np.array([list(b["InverseWorldTransform"]) for b in bones], np.float32).reshape(-1, 16)
    j["skins"] = [{"joints": [first + i for i in range(len(bones))],
                   "inverseBindMatrices": glb.add(np.ascontiguousarray(ibm), None, 5126, "MAT4")}]
    j["bufferViews"][-1].pop("target", None)
    holder = {"name": "character", "children": roots}
    # meshes, skinned to the skeleton by bone names
    placement = None
    for mraw in models_raw:
        root = Granny(mraw).root()
        for model in root.get("Models") or []:
            if placement is None and model.get("InitialPlacement"):
                placement = me.mat_from_scale_shear(model["InitialPlacement"])
            for mb in model.get("MeshBindings") or []:
                mesh = mb.get("Mesh")
                vd = mesh and mesh.get("PrimaryVertexData")
                if not vd or not isinstance(vd.get("Vertices"), ArrayRef) or not len(vd["Vertices"]):
                    continue
                v, types = me.vertex_array(vd["Vertices"])
                pos = me.decode_positions(v, types, mesh.get("ExtendedData"))
                attrs = {"POSITION": glb.add(pos, 34962, 5126, "VEC3", minmax=True)}
                nrm = me.decode_normals(v, types)
                if nrm is not None:
                    attrs["NORMAL"] = glb.add(nrm, 34962, 5126, "VEC3")
                uv = me.decode_uv(v, types)
                if uv is not None:
                    attrs["TEXCOORD_0"] = glb.add(uv, 34962, 5126, "VEC2")
                skinned = "BoneIndices" in types and "BoneWeights" in types
                binds = [bone_index.get(bb["BoneName"], 0) for bb in (mesh.get("BoneBindings") or [])]
                if skinned and binds:
                    lut = np.array(binds, np.uint16)
                    bi = v["BoneIndices"].astype(np.int64)
                    joints = lut[np.clip(bi, 0, len(lut) - 1)].astype(np.uint16)
                    w = v["BoneWeights"].astype(np.float32)
                    sw = w.sum(axis=1, keepdims=True)
                    sw[sw == 0] = 1
                    attrs["JOINTS_0"] = glb.add(np.ascontiguousarray(joints), 34962, 5123, "VEC4")
                    attrs["WEIGHTS_0"] = glb.add(np.ascontiguousarray(w / sw), 34962, 5126, "VEC4")
                elif binds:  # rigid mesh on one bone (e.g. a weapon)
                    n = len(pos)
                    attrs["JOINTS_0"] = glb.add(np.full((n, 4), binds[0], np.uint16), 34962, 5123, "VEC4")
                    attrs["WEIGHTS_0"] = glb.add(np.tile(np.array([1, 0, 0, 0], np.float32), (n, 1)), 34962, 5126, "VEC4")
                top = mesh["PrimaryTopology"]
                idx16, idx32 = top.get("Indices16"), top.get("Indices")
                if isinstance(idx16, ArrayRef) and len(idx16):
                    indices = np.frombuffer(idx16.raw(), dtype="<u2").astype(np.uint32)
                elif isinstance(idx32, ArrayRef) and len(idx32):
                    indices = np.frombuffer(idx32.raw(), dtype="<u4").astype(np.uint32)
                else:
                    continue
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
                                  "material": glb.material(me.texture_of(mat), (mat or {}).get("Name"), me.is_water(mat))})
                if not prims:
                    continue
                j["meshes"].append({"name": mesh.get("Name"), "primitives": prims})
                node = {"name": mesh.get("Name"), "mesh": len(j["meshes"]) - 1}
                if "JOINTS_0" in attrs:
                    node["skin"] = 0
                j["nodes"].append(node)
                holder["children"].append(len(j["nodes"]) - 1)
    if placement is not None:
        holder["matrix"] = placement.T.flatten().tolist()
    j["nodes"].append(holder)
    j["scenes"][0]["nodes"].append(len(j["nodes"]) - 1)
    # animations
    names = []
    if anims_raw:
        aroot = Granny(anims_raw).root()
        for anim in aroot.get("Animations") or []:
            name = anim.get("Name") or "anim"
            if (wanted and name not in wanted) or (not wanted and name.lower().startswith("additive")):
                continue
            channels, samplers = [], []
            for tg in anim.get("TrackGroups") or []:
                for tr in tg.get("TransformTracks") or []:
                    bi = bone_index.get(tr["Name"])
                    if bi is None:
                        continue
                    for key, path in (("OrientationCurve", "rotation"), ("PositionCurve", "translation"), ("ScaleShearCurve", "scale")):
                        c = curve((tr.get(key) or {}).get("CurveData"), key[0])
                        if c is None:
                            continue
                        times, vals = c
                        if path == "scale":
                            vals = scale_of(vals, key[0])
                        if path == "rotation":
                            vals = vals / np.maximum(np.linalg.norm(vals, axis=1, keepdims=True), 1e-9)
                            for k in range(1, len(vals)):  # shortest way between keys
                                if np.dot(vals[k], vals[k - 1]) < 0:
                                    vals[k] = -vals[k]
                        order = np.argsort(times, kind="stable")
                        times, vals = times[order], vals[order]
                        keep = np.concatenate([[True], np.diff(times) > 1e-6])
                        times, vals = times[keep], vals[keep]
                        ti = glb.add(np.ascontiguousarray(times.astype(np.float32).reshape(-1, 1)), None, 5126, "SCALAR", minmax=True)
                        j["bufferViews"][-1].pop("target", None)
                        vi = glb.add(np.ascontiguousarray(vals.astype(np.float32)), None, 5126, "VEC4" if path == "rotation" else "VEC3")
                        j["bufferViews"][-1].pop("target", None)
                        samplers.append({"input": ti, "output": vi, "interpolation": "LINEAR"})
                        channels.append({"sampler": len(samplers) - 1, "target": {"node": first + bi, "path": path}})
            if channels:
                j.setdefault("animations", []).append({"name": name, "channels": channels, "samplers": samplers})
                names.append(name)
    j["extras"] = {"animations": names}
    return glb.finish()


if __name__ == "__main__":
    import sys
    import pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
    import server  # noqa: PLC0415
    data = server.character_glb(sys.argv[1])
    pathlib.Path(sys.argv[2]).write_bytes(data)
    print(len(data), "bytes")
