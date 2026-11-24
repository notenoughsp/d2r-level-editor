"""D2R level editor backend: serves the web editor and game assets straight from CASC.

  python -I server.py [port]      then open http://127.0.0.1:8765/

Read-only towards the game: assets are read from the CASC storage through CascLib.
Edited presets are written to project/<preset path> and can be exported into a mod.
"""
import hashlib
import io
import json
import mimetypes
import os
import pathlib
import re
import shutil
import sys
import threading
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tools"))
import base64  # noqa: E402
import time  # noqa: E402

import casc  # noqa: E402
import collision  # noqa: E402
import model_export  # noqa: E402
from ds1 import DS1  # noqa: E402
import texture  # noqa: E402
import updater  # noqa: E402
import npc_creator  # noqa: E402

WEB = ROOT / "web"
DATA = casc.DATA
CACHE = DATA / "assets" / "cache"
PROJECT = DATA / "project"
LISTING = DATA / "assets" / "listing.tsv"

if not casc.is_game_dir(casc.GAME):
    print(f"Diablo II: Resurrected not found ({casc.GAME}). Put the folder into {casc.SETTINGS} "
          'as {"game": "<folder>"} or into the D2R_GAME variable.', file=sys.stderr)
    sys.exit(3)  # the launcher asks for the folder on this code
storage = casc.Casc()
casc_lock = threading.Lock()

# The file list of the game storage: built once (about a minute) and again after a game update.
_build_info = (pathlib.Path(casc.GAME) / ".build.info").stat().st_mtime
if not LISTING.exists() or LISTING.stat().st_mtime < _build_info:
    print("building the asset list from the game storage ...", flush=True)
    LISTING.parent.mkdir(parents=True, exist_ok=True)
    _tmp = LISTING.with_suffix(".tmp")
    with open(_tmp, "w", encoding="utf-8") as f:
        f.write("name\tsize\tavailable\n")
        for _name, _size, _avail in storage.files():
            f.write(f"{_name}\t{_size}\t{int(_avail)}\n")
    _tmp.replace(LISTING)

# lower-case virtual path ("data/hd/...") -> CASC name ("data:data\\hd\\...")
names = {}
for line in LISTING.read_text(encoding="utf-8").splitlines()[1:]:
    name, size, avail = line.split("\t")
    if avail == "1" and name.lower().startswith("data:"):
        names[name[5:].replace("\\", "/").lower()] = name


def read_asset(vpath, original=False):
    key = vpath.replace("\\", "/").lower().lstrip("/")
    if ".." in key.split("/") or ":" in key:
        raise FileNotFoundError(vpath)  # only game and project paths, nothing outside
    override = PROJECT / key
    if override.exists() and not original:
        return override.read_bytes()
    real = names.get(key)
    if not real:
        raise FileNotFoundError(vpath)
    with casc_lock:
        return storage.read(real)


def ds1_for_preset(preset_path):
    """HD preset data/hd/env/preset/<x>.json -> legacy data/global/tiles/<x>.ds1"""
    key = preset_path.replace("\\", "/").lower()
    m = re.match(r"data/hd/env/preset/(.+)\.json$", key)
    if not m:
        raise FileNotFoundError(preset_path)
    ds1 = f"data/global/tiles/{m.group(1)}.ds1"
    if ds1 not in names and not (PROJECT / ds1).exists():
        raise FileNotFoundError(ds1)
    return ds1


_size_cache = {}


NPC_FILE = PROJECT.parent / "editor_state" / "npcs.json"
NPC_INI = PROJECT.parent / "editor_state" / "d2r-npc.ini"


def npcs_payload():
    data = json.loads(NPC_FILE.read_text(encoding="utf-8")) if NPC_FILE.exists() else []
    return {"npcs": data, "looks": npc_creator.looks(read_asset), "traders": npc_creator.TRADERS}


def save_npcs(npcs):
    """Check and store the NPC list, then write the NPC rows into the project's tables.
    NPCs keep their place in the list: a new NPC's class id and its place in the "Add game
    object" list follow from it, so removed NPCs are kept (hidden) instead of shifting the rest."""
    old = {n["id"]: n for n in (json.loads(NPC_FILE.read_text(encoding="utf-8")) if NPC_FILE.exists() else [])}
    looks = npc_creator.looks(read_asset)
    clean, used = [], set()
    for n in npcs:
        name = str(n.get("name", "")).strip()[:40]
        if not name:
            raise ValueError("Every NPC needs a name.")
        nid = n.get("id") if n.get("id") in old else npc_creator.safe_id(name)
        base = nid
        k = 2
        while nid in used or (nid in old and nid != n.get("id")) or nid in looks:
            nid = f"{base}{k}"
            k += 1
        used.add(nid)
        role = "trade" if n.get("role") == "trade" else "talk"
        look = n.get("look") if n.get("look") in looks else "charsi"
        trade_like = n.get("trade_like") if n.get("trade_like") in npc_creator.TRADERS else "charsi"
        text = "\n".join(str(n.get("text", "")).replace("\r", "").split("\n")[:6])[:600]
        entry = {"id": nid, "name": name, "look": look, "role": role, "trade_like": trade_like,
                 "text": text, "removed": bool(n.get("removed"))}
        stages = [{"stage": int(st["stage"]), "text": "\n".join(str(st["text"]).replace("\r", "").split("\n")[:8])[:900]}
                  for st in n.get("stages", []) if str(st.get("text", "")).strip()]
        if stages:  # texts by quest stage (set by tools, not in the editor's NPC form)
            entry["stages"] = stages
        clean.append(entry)
    for nid, n in old.items():  # NPCs that vanished from the list stay as removed placeholders
        if nid not in used:
            clean.append({**n, "removed": True})
    NPC_FILE.parent.mkdir(parents=True, exist_ok=True)
    NPC_FILE.write_text(json.dumps(clean, indent=2, ensure_ascii=False), encoding="utf-8")
    ini, classes = npc_creator.build(clean, read_asset, PROJECT)
    if clean:
        NPC_INI.write_text("; written by the editor's NPC creator\n" + "\n".join(ini) + "\n", encoding="utf-8")
    else:
        NPC_INI.unlink(missing_ok=True)
    return {"npcs": clean, "classes": classes}


def preset_size(preset_path):
    """Size in tiles of a preset's map piece (cached; DS1 headers do not change size on edits)."""
    if preset_path not in _size_cache:
        d = DS1(read_asset(ds1_for_preset(preset_path)))
        _size_cache[preset_path] = (d.width, d.height)
    return _size_cache[preset_path]


def same_size_presets(preset_path):
    """Presets whose map piece has the same size in tiles: they can replace this one."""
    want = preset_size(preset_path)
    out = []
    for name in sorted(names):
        if name.startswith("data/hd/env/preset/") and name.endswith(".json") and name != preset_path:
            try:
                if preset_size(name) == want:
                    out.append(name)
            except (FileNotFoundError, ValueError, KeyError):
                continue
    return {"size": want, "presets": out}


def replace_preset(target, source):
    """Make target a copy of source: DS1 (tiles, collision, game objects) and HD preset JSON. The
    game still uses the target's place in lvlprest.txt, so both pieces must have the same size."""
    for pth in (target, source):
        if not pth.startswith("data/hd/env/preset/") or ".." in pth or not pth.endswith(".json"):
            raise ValueError("bad path")
    if preset_size(target) != preset_size(source):
        raise ValueError(f"Size does not match: {preset_size(source)} instead of {preset_size(target)} tiles")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = PROJECT.parent / "editor_state" / "replaced" / stamp
    # The terrain mesh and physics stay at the source's paths: the game does not load a terrain
    # model from a new folder (black ground); both pieces have the same size.
    files = {ds1_for_preset(target): read_asset(ds1_for_preset(source))}
    j = json.loads(read_asset(source).decode("utf-8"))
    j["name"] = json.loads(read_asset(target)).get("name", j.get("name"))
    files[target] = json.dumps(j, indent=1).encode("utf-8")
    for rel, data in files.items():
        dst = PROJECT / rel
        if dst.exists():  # keep what was there, in case the replacement was a mistake
            (backup / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dst, backup / rel)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
    links_file(target).unlink(missing_ok=True)   # links point at entities of the old layout
    draft_file(target).unlink(missing_ok=True)
    return {"replaced": target, "source": source, "files": len(files),
            "backup": str(backup) if backup.exists() else None}


def collision_payload(ds1_path):
    d = DS1(read_asset(ds1_path))
    grid = collision.compute(d, collision.tile_table(read_asset, d))
    orig = DS1(read_asset(ds1_path, original=True))
    changed = sorted({n for key, cells in d.layers.items()
                      for n, v in enumerate(cells) if v != (orig.layers.get(key) or [0] * len(cells))[n]})
    return {"ds1": ds1_path, "width": d.width, "height": d.height, "subtiles": [d.width * 5, d.height * 5],
            "grid": base64.b64encode(grid.tobytes()).decode(),
            "edited": [[n % d.width, n // d.width] for n in changed]}


def _excel(name):
    """Rows of a data/global/excel/<name>.txt table as dicts (tab separated, header row)."""
    lines = read_asset(f"data/global/excel/{name}.txt").decode("latin1").splitlines()  # project tables too
    head = lines[0].split("\t")
    return [dict(zip(head, l.split("\t"))) for l in lines[1:] if l.strip()]


_preset_index = None


# ---------------------------------------------------------------- model thumbnails and usage
def thumb_file(path):
    return CACHE / "thumb" / (hashlib.sha1(path.lower().encode()).hexdigest()[:20] + ".webp")


usage = {"state": "idle", "done": 0, "total": 0, "index": None}


def build_usage_index():
    """Which maps use which model (all game maps and the project's), built once in the background
    and kept in the cache until the game is updated."""
    cache = CACHE / "usage_index.json"
    stamp = str(_build_info)
    if cache.exists():
        data = json.loads(cache.read_text(encoding="utf-8"))
        if data.get("stamp") == stamp:
            usage.update(state="ready", index=data["index"])
            return
    presets = [k for k in names if k.startswith("data/hd/env/preset/") and k.endswith(".json")]
    usage.update(state="building", done=0, total=len(presets))
    idx = {}
    for k in presets:
        try:
            doc = json.loads(read_asset(k, original=True))
        except Exception:  # noqa: BLE001
            doc = {}
        seen = set()
        for e in doc.get("entities", []):
            for c in e.get("components", []):
                f = c.get("filename") if c.get("type") == "ModelDefinitionComponent" else None
                if f:
                    seen.add(f.lower())
        for f in seen:
            idx.setdefault(f, []).append(k)
        usage["done"] += 1
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"stamp": stamp, "index": idx}), encoding="utf-8")
    usage.update(state="ready", index=idx)


def model_usage(model):
    if usage["state"] == "idle":
        usage["state"] = "building"
        threading.Thread(target=build_usage_index, daemon=True).start()
    if usage["state"] != "ready":
        return {"state": "building", "done": usage["done"], "total": usage["total"]}
    key = model.lower()
    maps = list(usage["index"].get(key, []))
    pdir = PROJECT / "data/hd/env/preset"  # the project's maps are read fresh
    for f in pdir.rglob("*.json") if pdir.exists() else []:
        k = f.relative_to(PROJECT).as_posix()
        try:
            txt = f.read_text(encoding="utf-8").lower()
        except Exception:  # noqa: BLE001
            continue
        if f'"{key}"' in txt and k not in maps:
            maps.append(k)
        elif f'"{key}"' not in txt and k in maps:
            maps.remove(k)
    return {"state": "ready", "maps": sorted(maps)}


def preset_info(preset_path):
    """How the game uses a map piece, from lvlprest.txt: level-specific (unique) or a generic
    piece (LevelId 0) that random level generation can place many times."""
    global _preset_index
    if _preset_index is None:
        levels = {r.get("Id"): (r.get("*StringName") or r.get("Name")) for r in _excel("levels")}
        idx = {}
        for r in _excel("lvlprest"):
            files = [r.get(f"File{i}", "0") for i in range(1, 7)]
            files = [f.replace("\\", "/").lower() for f in files if f and f != "0"]
            for f in files:
                idx.setdefault(f, []).append({"name": r.get("Name"), "levelId": int(r.get("LevelId") or 0),
                                              "level": levels.get(r.get("LevelId")), "variants": len(files),
                                              "outdoors": r.get("Outdoors") == "1"})
        _preset_index = idx
    key = preset_path.replace("\\", "/").lower()
    m = re.match(r"data/hd/env/preset/(.+)\.json$", key)
    rows = _preset_index.get(m.group(1) + ".ds1", []) if m else []
    shared = any(r["levelId"] == 0 for r in rows) or len({r["levelId"] for r in rows}) > 1
    return {"rows": rows, "shared": shared, "known": bool(rows)}


_object_names = {}


def object_catalog(act):
    """Names of DS1 object ids for one act (act is the DS1 act field, 0-based):
    type 1 = row index among monpreset.txt rows of the act, type 2 = objpreset.txt Index -> objects.txt."""
    if act in _object_names:
        return _object_names[act]
    act_no = str(act + 1)
    npc = [{"id": i, "name": r["Place"]} for i, r in enumerate(x for x in _excel("monpreset") if x.get("Act") == act_no)]
    classes = {r.get("Class"): r.get("Name") or r.get("Class") for r in _excel("objects")}
    def label(cls):
        name = classes.get(cls)
        return cls if not name or name.lower() in ("dummy", cls.lower()) else f"{cls} ({name})"
    obj = [{"id": int(r["Index"]), "name": label(r.get("ObjectClass", ""))}
           for r in _excel("objpreset") if r.get("Act") == act_no and r.get("Index", "").isdigit()]
    _object_names[act] = {"npc": npc, "obj": sorted(obj, key=lambda o: o["id"])}
    return _object_names[act]


def objects_payload(ds1_path):
    from ds1 import Ds1Objects
    d = DS1(read_asset(ds1_path))
    o = Ds1Objects(d)
    cat = object_catalog(d.act)
    nname = {e["id"]: e["name"] for e in cat["npc"]}
    oname = {e["id"]: e["name"] for e in cat["obj"]}
    path_at = {(p["x"], p["y"]): [n[:2] for n in p["nodes"]] for p in o.paths}
    objs = [{**ob, "name": (nname if ob["type"] == 1 else oname).get(ob["id"], f"#{ob['id']}"),
             "path": path_at.get((ob["x"], ob["y"]), []) if ob["type"] == 1 else []} for ob in o.objects]
    return {"editable": o.editable, "act": d.act, "objects": objs, "catalog": cat}


def edit_objects(ds1_path, new_objects):
    """Replace the object list. Each object may carry "from": [x, y] (its old position) so its NPC
    path moves along; paths of removed NPCs are dropped."""
    from ds1 import Ds1Objects
    dst = PROJECT / ds1_path
    before = dst.read_bytes() if dst.exists() else None
    d = DS1(read_asset(ds1_path))
    o = Ds1Objects(d)
    if not o.editable:
        raise ValueError("The game objects of this DS1 file cannot be edited.")
    moved = {}
    new_paths = {}  # NPC position -> path drawn in the editor ([] removes it)
    clean = []
    for ob in new_objects:
        x, y = int(ob["x"]), int(ob["y"])
        if not (0 <= x < d.width * 5 and 0 <= y < d.height * 5):
            raise ValueError(f"Game object outside the map: subtile {x}, {y} (map: {d.width * 5} x {d.height * 5})")
        frm = tuple(ob.get("from") or (x, y))
        if ob.get("type") == 1:
            moved[frm] = (x, y)
            if "path" in ob:
                new_paths[(x, y)] = [[int(a), int(b)] for a, b in (ob["path"] or [])[:64]]
        clean.append({"type": int(ob["type"]), "id": int(ob["id"]), "x": x, "y": y, "flags": int(ob.get("flags", 0))})
    paths = []
    for p in o.paths:
        key = (p["x"], p["y"])
        if key not in moved:
            continue  # its NPC was removed
        nx, ny = moved[key]
        dx, dy = nx - p["x"], ny - p["y"]
        paths.append({"x": nx, "y": ny, "nodes": [[n[0] + dx, n[1] + dy] + n[2:] for n in p["nodes"]]})
    if new_paths:
        if d.version < 14 and any(new_paths.values()):
            raise ValueError("This DS1 file is too old for NPC paths.")
        per_node = 3 if d.version >= 15 else 2
        actions = [n[2] for p in o.paths for n in p["nodes"] if len(n) > 2]
        action = max(set(actions), key=actions.count) if actions else 1  # the map's usual node action
        paths = [p for p in paths if (p["x"], p["y"]) not in new_paths]
        for (x, y), pts in new_paths.items():
            for a, b in pts:
                if not (0 <= a < d.width * 5 and 0 <= b < d.height * 5):
                    raise ValueError(f"Path point outside the map: subtile {a}, {b}")
            if pts:
                paths.append({"x": x, "y": y, "nodes": [[a, b] + ([action] if per_node == 3 else []) for a, b in pts]})
    o.objects, o.paths = clean, paths
    d.tail = o.to_tail()
    write_ds1_override(ds1_path, d.to_bytes())
    hist = collision_history.setdefault(ds1_path, [])
    hist.append(before)
    del hist[:-100]
    collision_redo.pop(ds1_path, None)
    return objects_payload(ds1_path)


# Undo history of collision edits per DS1: previous override bytes (None = no override existed).
# Kept in memory for the editor session.
collision_history = {}


def write_ds1_override(ds1_path, data):
    dst = PROJECT / ds1_path
    if data is None:
        if dst.exists():
            dst.unlink()
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)


def edit_collision(ds1_path, ops):
    dst = PROJECT / ds1_path
    before = dst.read_bytes() if dst.exists() else None
    d = DS1(read_asset(ds1_path))
    if d.to_bytes() != d.raw:
        raise ValueError("This DS1 file cannot be written back without loss; edit refused.")
    d.original = DS1(read_asset(ds1_path, original=True))
    def write_asset(rel, data):
        f = PROJECT / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)

    subtiles = collision.SubtileTiles(read_asset, write_asset) if any(o["mode"].startswith("sub_") for o in ops) else None
    quarter_ops = [o for o in ops if o["mode"].startswith("q_")]
    if quarter_ops:
        collision.apply_quarters(d, quarter_ops, collision.quarter_tiles(read_asset))
    collision.apply_ops(d, [o for o in ops if not o["mode"].startswith("q_")], subtiles)
    same = (d.tail == d.original.tail and d.floor_layers == d.original.floor_layers
            and all(cells == (d.original.layers.get(key) or [0] * len(cells)) for key, cells in d.layers.items()))
    # everything (tiles and game objects) back to the original: drop the override instead of
    # shipping an identical file
    write_ds1_override(ds1_path, None if same else d.to_bytes())
    hist = collision_history.setdefault(ds1_path, [])
    hist.append(before)
    del hist[:-100]
    collision_redo.pop(ds1_path, None)  # a new edit ends the redo chain
    return collision_payload(ds1_path)


collision_redo = {}


def current_override(ds1_path):
    dst = PROJECT / ds1_path
    return dst.read_bytes() if dst.exists() else None


def undo_collision(ds1_path):
    hist = collision_history.get(ds1_path)
    if not hist:
        return None
    collision_redo.setdefault(ds1_path, []).append(current_override(ds1_path))
    write_ds1_override(ds1_path, hist.pop())
    return collision_payload(ds1_path)


def redo_collision(ds1_path):
    redo = collision_redo.get(ds1_path)
    if not redo:
        return None
    collision_history.setdefault(ds1_path, []).append(current_override(ds1_path))
    write_ds1_override(ds1_path, redo.pop())
    return collision_payload(ds1_path)


# Links between placed objects and the collision tiles blocked for them ("Collision under object"),
# so moving or deleting the object can move or remove its collision. Editor-only sidecar file.
def links_file(preset_path):
    key = preset_path.replace("\\", "/").lower().lstrip("/")
    return PROJECT.parent / "editor_state" / "links" / (key.replace("/", "__") + ".json")


def read_links(preset_path):
    f = links_file(preset_path)
    return json.loads(f.read_text()) if f.exists() else {}


def write_links(preset_path, links):
    f = links_file(preset_path)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(links, indent=1))


# Autosaved drafts of unsaved editor work, so a crash or closed tab loses nothing.
def draft_file(preset_path):
    key = preset_path.replace("\\", "/").lower().lstrip("/")
    return PROJECT.parent / "editor_state" / "drafts" / (key.replace("/", "__") + ".json")


# In-game test started from the editor: export, then tools/ingame_test.py in the background.
test_state = {"running": False, "report": "", "started": 0.0, "mod": ""}


def start_ingame_test(name):
    if test_state["running"]:
        return {"error": "A test is already running."}
    if game_running():
        return {"error": "The game is running; close it first."}
    export = export_mod(name)
    import time as _t
    # mark as running before the thread starts, so the first status poll cannot see a finished test
    test_state.update(running=True, report="", started=_t.time(), mod=name)

    def worker():
        import subprocess
        try:
            r = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "ingame_test.py"), name, "2"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                               capture_output=True, text=True, timeout=20 * 60)
            test_state["report"] = (r.stdout or "") + (("\n" + r.stderr) if r.returncode else "")
        except Exception as e:  # report every failure to the editor
            test_state["report"] = f"Test failed: {e}"
        finally:
            test_state["running"] = False

    threading.Thread(target=worker, daemon=True).start()
    return {"started": True, "export": export}


def known_file(key):
    """A game file or a file of the project (models and textures made by the editor's tools)."""
    return key in names or (PROJECT / key).is_file()


def version_key(key):
    """Cache key part that changes when a project file is written again (game files never change)."""
    f = PROJECT / key
    return f"|{f.stat().st_mtime_ns}" if f.is_file() else ""


def model_file(vpath, lod):
    key = vpath.replace("\\", "/").lower()
    if re.search(r"_lod\d\.model$", key) and known_file(key):
        return key
    base = key[:-len(".model")] if key.endswith(".model") else key
    for l in [lod, 0, 1, 2]:
        cand = f"{base}_lod{l}.model"
        if known_file(cand):
            return cand
    if known_file(key):
        return key
    raise FileNotFoundError(vpath)


CHARACTER_GROUPS = ("npc", "enemy", "monsters", "player")
_base_ids = None


def monster_base(mid):
    """monstats BaseId of a monster (zombie2 -> zombie1): variants share their base's look."""
    global _base_ids
    if _base_ids is None:
        rows = read_asset("data/global/excel/monstats.txt").decode("latin1").splitlines()
        h = rows[0].split("	")
        c = {k: i for i, k in enumerate(h)}
        _base_ids = {f[c["Id"]].lower(): f[c["BaseId"]].lower() for f in (r.split("	") for r in rows[1:]) if len(f) > c["BaseId"]}
    return _base_ids.get(mid.lower())


def character_path(ref):
    """A character JSON from its path or its monstats id (data/hd/character/<group>/<id>.json)."""
    ref = ref.replace("\\", "/").lower()
    if ref.endswith(".json") and known_file(ref):
        return ref
    for name in (ref, monster_base(ref)):
        for g in CHARACTER_GROUPS:
            p = f"data/hd/character/{g}/{name}.json"
            if name and known_file(p):
                return p
    raise FileNotFoundError(ref)


def character_glb(ref, lod=1):
    """A character as GLB with skeleton, skinning and its animations (tools/anim_export.py)."""
    import anim_export
    path = character_path(ref)
    doc = json.loads(read_asset(path))
    deps = doc.get("dependencies", {})
    # composite characters list alternatives per slot (lhand_lbw / lhand_sbw, special1_lit / _med):
    # one part per slot, the first that exists
    models, slots = [], set()
    for m in deps.get("models", []):
        p = (m.get("path") or "").lower()
        slot = p.rsplit("/", 1)[-1].split("_")[0].split(".")[0]
        if not p or slot in slots:
            continue
        try:
            models.append(read_asset(model_file(p, lod)))
            slots.add(slot)
        except FileNotFoundError:
            continue
    skels = [s["path"] for s in deps.get("skeletons", []) if s.get("path")]
    if not models or not skels:
        raise FileNotFoundError(f"{path}: no model or skeleton")
    # animations next to the character, or next to the skeleton it shares (rogue1 uses navi's)
    anims = None
    for folder in (path[:-len(".json")], skels[0].lower().rsplit("/skeleton/", 1)[0]):
        if known_file(f"{folder}/animation/combined.animations"):
            anims = read_asset(f"{folder}/animation/combined.animations")
            break
    return anim_export.build(models, read_asset(skels[0]), anims)


def write_project(path, data):
    key = path.replace("\\", "/").lower().lstrip("/")
    if ".." in key.split("/") or ":" in key or not key.startswith("data/"):
        raise ValueError(f"bad path {path}")
    dst = PROJECT / key
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)


def decode_image(b64):
    from PIL import Image
    raw = base64.b64decode(b64.split(",", 1)[-1])
    if len(raw) > 40 * 1024 * 1024:
        raise ValueError("The picture is too large (40 MB at most).")
    img = Image.open(io.BytesIO(raw))
    img.load()
    return img


def make_retexture(body):
    """A copy of a game model with new textures (tools/retexture.py) from the editor's form."""
    import retexture
    model = str(body.get("model", "")).lower()
    if not re.fullmatch(r"data/hd/[a-z0-9_/]+\.model", model):
        raise ValueError("Choose a game model first.")
    tag = str(body.get("tag", "")).lower()
    if not retexture.TAG.match(tag):
        raise ValueError("Name: four letters or digits, e.g. gold")
    mode = body.get("mode")
    if mode == "tint":
        rgb = tuple(max(0, min(255, int(v))) for v in body.get("rgb", [200, 160, 60]))
        strength = max(0.0, min(1.0, float(body.get("strength", 0.85))))
        make = lambda img, _p: retexture.tinted(img, rgb, strength)  # noqa: E731
    elif mode in ("image", "material"):
        picture = decode_image(body.get("image", ""))
        if mode == "image":
            picture = picture.convert("RGBA")
            make = lambda img, _p: picture.resize(img.size)  # noqa: E731
        else:
            repeat = max(1, min(16, int(body.get("repeat", 2))))
            make = lambda img, _p: retexture.material(img, picture, repeat)  # noqa: E731
    else:
        raise ValueError("unknown mode")
    try:
        new, textures = retexture.retexture(model, tag, make, lambda p: read_asset(p, original=True),
                                            write_project, read_asset)
    except FileNotFoundError:
        raise ValueError("Model not found: only game models can be recoloured (not copies made by the editor).")
    return {"model": new, "textures": len(textures)}


def make_import(body):
    """A new game model from an OBJ or glTF (.glb) mesh (tools/meshimport.py)."""
    import meshimport
    name = str(body.get("name", "")).lower()
    if not re.fullmatch(r"[a-z0-9_]{2,40}", name):
        raise ValueError("Model name: 2-40 small letters, digits or _")
    fname = str(body.get("filename", "")).lower()
    ext = ".glb" if fname.endswith(".glb") else ".obj" if fname.endswith(".obj") else None
    if not ext:
        raise ValueError("Mesh file: .obj or .glb")
    raw = base64.b64decode(str(body.get("mesh", "")).split(",", 1)[-1])
    if not raw or len(raw) > 60 * 1024 * 1024:
        raise ValueError("The mesh file is empty or too large (60 MB at most).")
    height = max(0.5, min(200.0, float(body.get("height", 8))))
    tex = decode_image(body["texture"]) if body.get("texture") else None
    tmp = CACHE / "import"
    tmp.mkdir(parents=True, exist_ok=True)
    src = tmp / ("upload" + ext)
    src.write_bytes(raw)
    try:
        model, verts, tris = meshimport.import_mesh(str(src), f"data/hd/env/model/custom/{name}.model",
                                                    lambda p: read_asset(p, original=True), write_project,
                                                    read_asset, tex, height)
    finally:
        src.unlink(missing_ok=True)
    return {"model": model, "vertices": verts, "triangles": tris}


def cached(kind, key, make, ext):
    h = hashlib.sha1(key.encode()).hexdigest()[:16]
    p = CACHE / kind / f"{h}.{ext}"
    if p.exists():
        return p.read_bytes()
    data = make()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return data


def sd_map(preset_path):
    """The map piece drawn with the legacy (SD) tile graphics, as PNG plus the layout numbers the
    editor needs to map pixels back to tiles (tools/sd_render.py)."""
    import sd_render  # noqa: PLC0415
    ds1_path = ds1_for_preset(preset_path)
    raw = read_asset(ds1_path)
    d = DS1(raw)
    act = ds1_path.split("/")[3]
    act_folder = "act5" if act == "expansion" else act
    paths = collision.tile_paths(d)
    key = hashlib.sha1(raw + b"".join(read_asset(p) if (PROJECT / p).exists() else p.encode() for p in paths)).hexdigest()

    def make():
        img = sd_render.render(d, read_asset, paths, act_folder)
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=False, compress_level=3)
        return buf.getvalue()

    png = cached("sd", key, make, "png")
    return png, {"width": d.width, "height": d.height, "originX": d.height * 80, "top": 320}


def make_png(vpath, mip):
    from PIL import Image
    raw = read_asset(vpath)
    t = texture.parse(raw)
    mip = min(mip, len(t["mips"]) - 1)
    # re-point the DDS writer at the requested mip
    off, size = t["mips"][mip]
    w, h = max(1, t["width"] >> mip), max(1, t["height"] >> mip)
    # Pillow decodes the block data; sRGB vs linear only matters to the GPU, so decode as UNORM
    fmt = texture.FORMATS.get(t["format"], ("BC3_UNORM",))[0].replace("_SRGB", "")
    import struct
    header = struct.pack("<4sIIIIIII44x", b"DDS ", 124, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000, h, w, size, 1, 1)
    pf = struct.pack("<II4sIIIII", 32, 0x4, b"DX10", 0, 0, 0, 0, 0)
    caps = struct.pack("<IIII4x", 0x1000, 0, 0, 0)
    dx10 = struct.pack("<IIIII", texture.DXGI[fmt], 3, 0, 1, 0)
    img = Image.open(io.BytesIO(header + pf + caps + dx10 + raw[off:off + size]))
    out = io.BytesIO()
    img.save(out, "PNG", compress_level=1)
    return out.getvalue()


def list_presets():
    out = []
    for k in names:
        if k.startswith("data/hd/env/preset/") and k.endswith(".json"):
            out.append(k)
    for p in PROJECT.rglob("*.json"):
        k = p.relative_to(PROJECT).as_posix()
        if k.startswith("data/hd/env/preset/") and k not in names:
            out.append(k)
    return sorted(out)


def list_models(q, limit, own_only=False):
    seen = []
    ql = q.lower()
    # models made by tools/retexture.py live only in the project
    own = [p.relative_to(PROJECT).as_posix().lower() for p in (PROJECT / "data/hd").rglob("*.model")] \
        if (PROJECT / "data/hd").exists() else []
    for k in ([] if own_only else list(names)) + own:
        if not k.endswith(".model") or "/hd/" not in k:
            continue
        base = re.sub(r"_lod\d\.model$", ".model", k)
        if ql and ql not in base:
            continue
        if base.endswith("terrain.model") or "/preset/" in base:
            continue
        seen.append(base)
    seen = sorted(set(seen))
    return seen[:limit], len(seen)


MODINFO = PROJECT.parent / "editor_state" / "modinfo.json"
PROJECTS = PROJECT.parent / "projects"          # stored projects that are not open
CURRENT_PROJECT = PROJECT.parent / "current_project.txt"
project_lock = threading.Lock()


KITS = PROJECT.parent / "kits"  # building kits: shared by all projects


def kit_file(name):
    if not re.fullmatch(r"[^\\/:*?\"<>|]{1,60}", name or "") or name.strip() != name or name.startswith("."):
        raise ValueError("Kit name: up to 60 characters, no \\ / : * ? \" < > |")
    return KITS / f"{name}.json"


def list_kits():
    out = []
    for f in sorted(KITS.glob("*.json"), key=lambda p: p.stem.lower()) if KITS.exists() else []:
        try:
            out.append({"name": f.stem, "count": len(json.loads(f.read_text(encoding="utf-8")).get("items", []))})
        except Exception:  # noqa: BLE001
            continue
    return out


# ---------------------------------------------------------------- act editor (d2r-world-mods)
# New areas, bosses and quest chains are built by the separate d2r-world-mods tools (World
# Waypoints, quest plugin). The editor edits their act description and runs them when they are
# found next to the editor (or in D2R_WORLD_MODS).
WORLD = pathlib.Path(os.environ.get("D2R_WORLD_MODS") or ROOT.parent / "d2r-world-mods")
_world_catalog = None


def world_available():
    return (WORLD / "tools" / "build_act6.py").exists()


def act_spec_file():
    return WORLD / "act6" / "act6.json"


def world_catalog():
    """Monster ids (for monsters, bosses' looks), treasure classes and dungeon level templates."""
    global _world_catalog
    if _world_catalog is None:
        def rows(name):
            raw = read_asset(f"data/global/excel/{name}.txt", original=True).decode("latin1").replace("\r\n", "\n").split("\n")
            head = raw[0].split("\t")
            return head, [r.split("\t") for r in raw[1:] if r]
        h, r = rows("monstats")
        c = {k: i for i, k in enumerate(h)}
        monsters = [x[c["Id"]] for x in r if len(x) > c["Id"] and x[c["Id"]] and x[c["Id"]] != "Expansion"]
        h, r = rows("treasureclassex")
        tcs = [x[0] for x in r if x and x[0]]
        h, r = rows("levels")
        c = {k: i for i, k in enumerate(h)}
        mazes = [{"id": int(x[c["Id"]]), "name": x[c["Name"]]} for x in r
                 if len(x) > c["DrlgType"] and x[c["DrlgType"]] == "1" and x[c["Id"]].isdigit()]
        _world_catalog = {"monsters": monsters, "tcs": tcs, "mazes": mazes}
    return _world_catalog


def free_offset(w, h, act=4, taken=()):
    """A free place (tiles) in an act's world for a new level of w x h tiles: not overlapping the
    game's levels of that act (levels.txt, the project's copy), nor the given rectangles, and
    below 6500 tiles (coordinates above 32767 subtiles are not drawn)."""
    raw = read_asset("data/global/excel/levels.txt").decode("latin1").replace("\r\n", "\n").split("\n")
    head = raw[0].split("\t")
    c = {k: i for i, k in enumerate(head)}
    rects = list(taken)
    for line in raw[1:]:
        r = line.split("\t")
        if len(r) <= c["OffsetY"] or r[c["Act"]] != str(act):
            continue
        try:
            ox, oy = int(r[c["OffsetX"]] or 0), int(r[c["OffsetY"]] or 0)
            sx, sy = int(r[c["SizeX"]] or 0) or 100, int(r[c["SizeY"]] or 0) or 100
        except ValueError:
            continue
        rects.append((ox, oy, sx, sy))
    m = 20
    for y in range(200, 6500 - h, 50):
        for x in range(3000, 6500 - w, 50):
            if all(x + w + m <= ox or ox + sx + m <= x or y + h + m <= oy or oy + sy + m <= y for ox, oy, sx, sy in rects):
                return [x, y]
    raise ValueError("No free place for the new area in this act's world.")


def new_map(template, name, empty):
    """A new map in the project: a copy of a game map (preset JSON and DS1 tiles) under a new name,
    optionally without its models and game objects. The terrain stays at the template's paths."""
    from ds1 import Ds1Objects
    template = template.replace("\\", "/").lower()
    if not re.fullmatch(r"data/hd/env/preset/[a-z0-9_/]+\.json", template):
        raise ValueError("Choose a map as template.")
    if not re.fullmatch(r"[a-z0-9_]{2,40}", name):
        raise ValueError("Map name: 2-40 small letters, digits or _")
    dst = template.rsplit("/", 1)[0] + f"/{name}.json"
    if known_file(dst):
        raise ValueError(f"{dst} exists already.")
    doc = json.loads(read_asset(template))
    terrain = any(c.get("type") == "TerrainDefinitionComponent" for e in doc.get("entities", []) for c in e.get("components", []))
    if empty:
        doc["entities"] = [e for e in doc.get("entities", [])
                           if any(c.get("type") in ("TerrainDefinitionComponent", "TerrainStampDefinitionComponent") for c in e.get("components", []))]
    doc["name"] = name
    write_project(dst, json.dumps(doc, indent=1).encode())
    src_ds1, dst_ds1 = ds1_for_preset(template), dst.replace("data/hd/env/preset/", "data/global/tiles/")[:-5] + ".ds1"
    d = DS1(read_asset(src_ds1))
    if empty:
        o = Ds1Objects(d)
        if o.editable:
            o.objects, o.paths = [], []
            d.tail = o.to_tail()
    write_project(dst_ds1, d.to_bytes())
    w, h = preset_size(template)
    return {"path": dst, "size": [w, h], "terrain": terrain}


def world_state():
    if not world_available():
        return {"available": False, "path": str(WORLD)}
    return {"available": True, "path": str(WORLD), "spec": json.loads(act_spec_file().read_text(encoding="utf-8")),
            "catalog": world_catalog()}


def save_act_spec(spec):
    for key in ("levels", "zones", "bosses", "quest", "npcs", "questlog"):
        if key not in spec:
            raise ValueError(f"The act description needs '{key}'.")
    ids = [z["id"] for z in spec["zones"]]
    if len(ids) != len(set(ids)):
        raise ValueError("Two areas have the same level id.")
    f = act_spec_file()
    backup = f.with_suffix(".json.bak")
    if f.exists():
        shutil.copy2(f, backup)
    f.write_text(json.dumps(spec, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"saved": str(f)}


def build_act(export_name=None):
    """Run the act build into this editor's project; optionally export the mod and install d2r-world."""
    import subprocess
    env = dict(os.environ, D2R_EDITOR_DATA=str(PROJECT.parent), D2R_GAME=str(casc.GAME),
               D2R_EDITOR_TOOLS=str(ROOT / "tools"), ACT_SPEC=str(act_spec_file()))
    out = []

    def run(args):
        r = subprocess.run([sys.executable, "-I", *args], env=env, capture_output=True, text=True, timeout=1200)
        out.append((r.stdout or "") + (r.stderr or ""))
        if r.returncode:
            raise ValueError("\n".join(out)[-3000:])
    run([str(WORLD / "tools" / "build_act6.py")])
    result = {"log": "\n".join(out)[-6000:]}
    if export_name:
        result["export"] = export_mod(export_name, read_modinfo())
        prefix = json.loads(act_spec_file().read_text(encoding="utf-8")).get("prefix", "a6")
        run([str(WORLD / "tools" / "install_world.py"), export_name, "--zones", f"{prefix}_*"])
        result["log"] = "\n".join(out)[-6000:]
    return result


# ---------------------------------------------------------------- into the game
def game_running():
    """D2RLoader runs its own copy of the game, so both process names count."""
    import subprocess
    r = subprocess.run(["tasklist", "/NH", "/FO", "CSV"], capture_output=True, text=True)
    names = {line.split(",")[0].strip('"').lower() for line in r.stdout.splitlines() if line}
    return bool(names & {"d2r.exe", "d2rloader.exe"})


def level_rows():
    raw = read_asset("data/global/excel/levels.txt").decode("latin1").replace("\r\n", "\n").split("\n")
    head = raw[0].split("\t")
    c = {k: i for i, k in enumerate(head)}
    out = {}
    for line in raw[1:]:
        r = line.split("\t")
        if len(r) > c["OffsetY"] and r[c["Id"]].isdigit():
            out[int(r[c["Id"]])] = {"name": r[c["Name"]], "x": int(r[c["OffsetX"]] or 0), "y": int(r[c["OffsetY"]] or 0)}
    return out


play_state = {"running": False, "message": ""}


def harness_run(name, ini, moves, on_exit=None):
    """Start the game with the test harness in mod <name> (exported before). The harness files are
    removed again when the game ends."""
    import subprocess
    pdir = pathlib.Path(casc.GAME) / "mods" / name / "d2rloader" / "plugins"
    pdir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "plugin" / "d2r-test-harness.dll", pdir / "d2r-test-harness.dll")
    (pdir / "test-harness.ini").write_text(ini)
    (pdir / "moves.txt").write_text(moves)
    for f in ("harness.log", "done.txt", "arrived.txt"):
        (pdir / f).unlink(missing_ok=True)
    proc = subprocess.Popen([str(pathlib.Path(casc.GAME) / "D2RLoader.exe"), "-mod", name], cwd=str(casc.GAME))

    def wait():
        proc.wait()
        log = (pdir / "harness.log").read_text(errors="replace") if (pdir / "harness.log").exists() else ""
        for f in ("d2r-test-harness.dll", "test-harness.ini", "moves.txt", "done.txt", "arrived.txt"):
            (pdir / f).unlink(missing_ok=True)
        play_state["running"] = False
        if on_exit:
            on_exit(log)
    threading.Thread(target=wait, daemon=True).start()


def play_here(path, x, z):
    """Export the mod and start the game right at this place of the map (its own level only)."""
    if play_state["running"] or game_running():
        raise ValueError("The game is running; close it first.")
    info = preset_info(path)
    levels = sorted({r["levelId"] for r in info["rows"] if r["levelId"] > 0})
    if not levels or info["shared"]:
        raise ValueError("This map is a piece of random areas: the game places it differently every time, so there is no fixed place to go to.")
    lv = levels[0]
    row = level_rows().get(lv)
    if not row:
        raise ValueError(f"Level {lv} not found.")
    info_mod = read_modinfo()
    name = info_mod["name"]
    export_mod(name, info_mod)
    tx, ty = int(x // 2), int(z // 2)  # subtiles in the map; the harness adds the level origin of this game
    play_state.update(running=True, message=f"{row['name']} at {tx},{ty}")
    harness_run(name, f"runs=1\nplay=1\nvary_game_seed=0\nstart_level={lv}\nradius=8\nsettle_ticks=60\n", f"T {tx} {ty}\n")
    return {"mod": name, "level": lv, "levelName": row["name"], "target": [tx, ty]}


act_test_state = {"running": False, "report": ""}


def act_test():
    """Warp into every area of the act once (second monitor, muted) and check that it is reached."""
    if play_state["running"] or act_test_state["running"] or game_running():
        raise ValueError("The game is running; close it first.")
    spec = json.loads(act_spec_file().read_text(encoding="utf-8"))
    name = read_modinfo()["name"]
    ids = [z["id"] for z in spec["zones"]]
    moves = "".join(f"L {i} 0\nw 2500\n" for i in ids)
    act_test_state.update(running=True, report="")
    play_state["running"] = True

    def done(log):
        got = [int(m) for m in re.findall(r"after warp: player \(-?\d+,-?\d+\) in level (-?\d+)", log)]
        lines = []
        for k, i in enumerate(ids):
            ok = k < len(got) and got[k] == i
            z = spec["zones"][k]
            lines.append(f"{'PASS' if ok else 'FAIL'} {z['name']} (level {i})" + ("" if ok else f": arrived in {got[k] if k < len(got) else 'nothing'}"))
        act_test_state.update(running=False, report="\n".join(lines) or "FAIL no log")
    harness_run(name, "runs=1\nvary_game_seed=0\nradius=8\nsettle_ticks=60\n", moves, done)
    return {"started": True, "areas": len(ids), "mod": name}


# ---------------------------------------------------------------- loot (treasure classes)
TC_FIELDS = ["Picks", "Unique", "Set", "Rare", "Magic", "NoDrop"] + [f"{k}{i}" for i in range(1, 11) for k in ("Item", "Prob")]
TC_BANKS = ("data/global/excel/treasureclassex.txt", "data/global/excel/base/treasureclassex.txt")


def tc_rows(path):
    raw = read_asset(path).decode("latin1")
    nl = "\r\n" if "\r\n" in raw else "\n"
    rows = [r.split("\t") for r in raw.split(nl)]
    while rows and rows[-1] == [""]:
        rows.pop()
    return rows, nl


def loot_list(q):
    rows, _ = tc_rows(TC_BANKS[0])
    names = [r[0] for r in rows[1:] if r and r[0]]
    ql = q.lower()
    return [n for n in names if ql in n.lower()][:300]


def loot_get(name):
    rows, _ = tc_rows(TC_BANKS[0])
    h = rows[0]
    r = next((r for r in rows[1:] if r and r[0] == name), None)
    if r is None:
        raise ValueError(f"No treasure class {name}")
    orig, _ = tc_rows_original()
    o = next((x for x in orig[1:] if x and x[0] == name), None)
    return {"name": name, "fields": {k: (r[h.index(k)] if h.index(k) < len(r) else "") for k in TC_FIELDS},
            "changed": o is not None and o != r}


def tc_rows_original():
    raw = read_asset(TC_BANKS[0], original=True).decode("latin1")
    nl = "\r\n" if "\r\n" in raw else "\n"
    return [r.split("\t") for r in raw.split(nl)], nl


def loot_save(name, fields, reset=False):
    """Change one treasure class in both table sets of the project (or put it back)."""
    known = {r[0] for r in tc_rows(TC_BANKS[0])[0][1:] if r and r[0]}
    for k in range(1, 11):
        item = str(fields.get(f"Item{k}", "")).strip()
        if item and item not in known and not re.fullmatch(r"[a-z0-9]{3,4}|gld(,mul=\d+)?", item):
            raise ValueError(f"Unknown entry {item}: a treasure class name or an item code (e.g. gld, r33, cap)")
    for bank in TC_BANKS:
        try:
            rows, nl = tc_rows(bank)
            orig = read_asset(bank, original=True).decode("latin1").split(nl)
        except FileNotFoundError:
            continue
        h = rows[0]
        for r in rows[1:]:
            if r and r[0] == name:
                if reset:
                    o = next((x.split("\t") for x in orig if x.split("\t")[0] == name), None)
                    if o:
                        r[:] = o
                else:
                    r += [""] * (len(h) - len(r))
                    for k in TC_FIELDS:
                        v = str(fields.get(k, "")).strip()
                        if k.startswith("Prob") or k in ("Picks", "Unique", "Set", "Rare", "Magic", "NoDrop"):
                            if v and not re.fullmatch(r"-?\d{1,6}", v):
                                raise ValueError(f"{k}: a whole number")
                        r[h.index(k)] = v
        data = (nl.join("\t".join(r) for r in rows) + nl).encode("latin1")
        if data == read_asset(bank, original=True):
            (PROJECT / bank).unlink(missing_ok=True)
        else:
            write_project(bank, data)
    return loot_get(name)


def current_project():
    return CURRENT_PROJECT.read_text(encoding="utf-8").strip() if CURRENT_PROJECT.exists() else "Default"


def list_projects():
    names = {current_project()}
    if PROJECTS.exists():
        names |= {p.name for p in PROJECTS.iterdir() if p.is_dir()}
    return {"current": current_project(), "projects": sorted(names, key=str.lower)}


def switch_project(name):
    """The open project lives in project/ and editor_state/ (every tool uses these paths); the
    others wait in projects/<name>/. Switching moves the folders (a rename, nothing is copied)."""
    if not re.fullmatch(r"[A-Za-z0-9 _-]{1,40}", name):
        raise ValueError("Project name: letters, digits, space, _ and -")
    with project_lock:
        cur = current_project()
        if name == cur:
            return list_projects()
        state = PROJECT.parent / "editor_state"
        park = PROJECTS / cur
        if park.exists():
            raise ValueError(f"projects/{cur} exists already; move it away first.")
        park.mkdir(parents=True)
        try:
            for src, dst in ((PROJECT, park / "project"), (state, park / "editor_state")):
                if src.exists():
                    src.rename(dst)
        except OSError:
            raise ValueError("A project file is in use; close the game and other programs and try again.")
        nxt = PROJECTS / name
        for part, dst in (("project", PROJECT), ("editor_state", state)):
            if (nxt / part).exists():
                (nxt / part).rename(dst)
        if nxt.exists():
            shutil.rmtree(nxt, ignore_errors=True)  # empty now
        PROJECT.mkdir(parents=True, exist_ok=True)
        CURRENT_PROJECT.write_text(name, encoding="utf-8")
        _size_cache.clear()
    return list_projects()
EXPORTS = PROJECT.parent / "exports"


def read_modinfo():
    info = {"name": "D2REditor", "title": "", "version": "0.1.0", "author": "", "description": "", "website": ""}
    if MODINFO.exists():
        info.update(json.loads(MODINFO.read_text(encoding="utf-8")))
    return info


def write_modinfo(body):
    info = read_modinfo()
    for k in info:
        if k in body:
            info[k] = str(body[k]).strip()[:2000 if k == "description" else 120]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", info["name"]):
        raise ValueError("Mod name: only letters, digits, _ and -")
    MODINFO.parent.mkdir(parents=True, exist_ok=True)
    MODINFO.write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")
    return info


def project_check():
    """Problems that would make the exported mod break or look wrong, found before the export."""
    from collections import Counter
    probs = []
    pdir = PROJECT / "data/hd/env/preset"
    files = sorted(pdir.rglob("*.json")) if pdir.exists() else []
    if not files and not (PROJECT / "data").exists():
        probs.append({"level": "warn", "text": "The project is empty: nothing to export yet."})
    for f in files:
        key = f.relative_to(PROJECT).as_posix()
        short = key.replace("data/hd/env/preset/", "")
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            probs.append({"level": "error", "text": f"{short}: not valid JSON ({e})"})
            continue
        ents = doc.get("entities", [])
        dups = [i for i, n in Counter(e.get("id") for e in ents).items() if n > 1]
        if dups:
            probs.append({"level": "error", "text": f"{short}: {len(dups)} object ID(s) used twice"})
        try:
            w, h = preset_size(key)
        except Exception:  # noqa: BLE001
            w = h = None
        missing, outside = set(), 0
        for e in ents:
            comps = {c.get("type"): c for c in e.get("components", [])}
            md = comps.get("ModelDefinitionComponent")
            if md and md.get("filename"):
                try:
                    model_file(md["filename"], 0)
                except FileNotFoundError:
                    missing.add(md["filename"])
            pf = comps.get("PrefabPlacementDefinitionComponent")
            if pf and pf.get("prefab") and not known_file(pf["prefab"].lower()):
                missing.add(pf["prefab"])
            t = comps.get("TransformDefinitionComponent")
            if w and t and not comps.get("TerrainDefinitionComponent"):
                p = t.get("position", {})
                if not (-30 <= p.get("x", 0) <= w * 10 + 30 and -30 <= p.get("z", 0) <= h * 10 + 30):
                    outside += 1
        for m in sorted(missing)[:5]:
            probs.append({"level": "error", "text": f"{short}: missing model or prefab {m}"})
        if len(missing) > 5:
            probs.append({"level": "error", "text": f"{short}: {len(missing) - 5} more missing models"})
        if outside:
            probs.append({"level": "warn", "text": f"{short}: {outside} object(s) far outside the map"})
    ddir = PROJECT.parent / "editor_state" / "drafts"
    for d in sorted(ddir.glob("*.json")) if ddir.exists() else []:
        probs.append({"level": "warn", "text": "Unsaved draft (not exported): " + d.stem.replace("__", "/").replace("data/hd/env/preset/", "")})
    return {"problems": probs, "maps": len(files)}


def make_upload_zip(name, mod, info):
    """A zip with mods/<name>/ and a README, ready to upload (e.g. to Nexus Mods)."""
    import zipfile
    EXPORTS.mkdir(parents=True, exist_ok=True)
    out = EXPORTS / f"{name}-{info.get('version') or '0.1.0'}.zip"
    readme = "\n".join(x for x in [
        info.get("title") or name, f"Version {info.get('version', '')}" + (f" by {info['author']}" if info.get("author") else ""),
        "", info.get("description", ""), "",
        "INSTALL", f"1. Copy the folder mods\\{name} into your Diablo II: Resurrected folder.",
        f"2. Start the game with D2RLoader (https://d2rloader.net): D2RLoader.exe -mod {name}",
        "", "Made with the D2R Level Editor: https://github.com/notenoughsp/d2r-level-editor",
        info.get("website", "")] if x is not None)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(mod.rglob("*")):
            if p.is_file() and not p.name.endswith((".log", ".old")):
                z.write(p, pathlib.Path("mods") / name / p.relative_to(mod))
        z.writestr(f"README - {name}.txt", readme.replace("\n", "\r\n"))
    return out


def export_mod(name, info=None, make_zip=False):
    """Copy every edited file from project/ into <game>/mods/<name>/<name>.mpq/ as loose files.

    D2R loads loose files from a folder named <name>.mpq when started with -mod <name>.
    A d2rloader/metadata.json lets D2RLoader list the mod as well.
    """

    mod = pathlib.Path(casc.GAME) / "mods" / name
    data_root = mod / f"{name}.mpq"
    files = [p for p in PROJECT.rglob("*") if p.is_file()]
    if data_root.exists():
        # Move the old export aside first: if the game has the files open the rename fails and
        # nothing is lost; deleting directly could stop half way.
        old = data_root.with_name(data_root.name + ".old")
        if old.exists():
            shutil.rmtree(old)
        try:
            data_root.rename(old)
        except OSError:
            raise ValueError("The mod folder is in use (is the game running?); close the game and export again.")
        shutil.rmtree(old, ignore_errors=True)
    for p in files:
        dst = data_root / p.relative_to(PROJECT)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst)
    # The game preloads DS1 files per act from combined_ds1.bin, so edited DS1s (collision)
    # must also be written into a rebuilt copy of that file.
    import combined_ds1
    by_act = {}
    for p in files:
        rel = p.relative_to(PROJECT).as_posix().lower()
        m = re.match(r"data/global/tiles/([^/]+)/(.+\.ds1)$", rel)
        if m:
            by_act.setdefault(m.group(1), {})[m.group(2)] = p.read_bytes()
    for act, overrides in by_act.items():
        bin_path = f"data/global/tiles/{act}/combined_ds1.bin"
        rebuilt, done = combined_ds1.replace(read_asset(bin_path, original=True), overrides, add_new=True)
        missing = set(overrides) - set(done)
        if missing:
            print("export: not in", bin_path, sorted(missing))
        dst = data_root / bin_path
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(rebuilt)
    data_root.mkdir(parents=True, exist_ok=True)  # also for an empty project
    (data_root / "modinfo.json").write_text(json.dumps({"name": name, "savepath": f"{name}/"}, indent=2))
    # mod-scoped fixed-seed plugin: active only while this mod runs, never for other mods
    # NPCs from the NPC creator: the d2r-npc plugin gives them their behaviour and speech
    pdir = mod / "d2rloader" / "plugins"
    if NPC_INI.exists() and (ROOT / "plugin" / "d2r-npc.dll").exists():
        pdir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "plugin" / "d2r-npc.dll", pdir / "d2r-npc.dll")
        shutil.copy2(NPC_INI, pdir / "d2r-npc.ini")
    else:
        (pdir / "d2r-npc.dll").unlink(missing_ok=True)
        (pdir / "d2r-npc.ini").unlink(missing_ok=True)
    plugin = ROOT / "plugin" / "d2r-fixed-seed.dll"
    if plugin.exists():
        pdir = mod / "d2rloader" / "plugins"
        pdir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(plugin, pdir / plugin.name)
    meta = mod / "d2rloader" / "metadata.json"
    meta.parent.mkdir(parents=True, exist_ok=True)
    meta.write_text(json.dumps({"schemaVersion": 1, "d2rloader": {"version": "1.3.1-beta"},
                                "metadata": {"name": (info or {}).get("title") or name,
                                             "author": (info or {}).get("author") or "D2R Level Editor",
                                             "modVersion": (info or {}).get("version") or "0.1.0",
                                             "description": (info or {}).get("description") or "HD level edits made with the D2R level editor.",
                                             "website": (info or {}).get("website") or ""}}, indent=2))
    result = {"mod": str(mod), "files": len(files)}
    if make_zip:
        result["zip"] = str(make_upload_zip(name, mod, info or {}))
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # editor files and JSON always fresh; converted assets are versioned by URL and can be cached
        fresh = ctype == "application/json" or ctype.startswith("text/")
        self.send_header("Cache-Control", "no-cache" if fresh else "max-age=3600")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        if (self.headers.get("Host") or "").split(":")[0] not in ("127.0.0.1", "localhost"):
            return self.send(403, {"error": "forbidden"})  # DNS rebinding: only local host names
        try:
            if u.path == "/" or u.path.startswith("/web/"):
                rel = "index.html" if u.path == "/" else u.path[len("/web/"):]
                self.static(WEB / rel)
            elif u.path.startswith("/three/"):
                self.static(WEB / "node_modules" / "three" / u.path[len("/three/"):])
            elif u.path == "/api/presets":
                self.send(200, list_presets())
            elif u.path == "/api/kits":
                self.send(200, list_kits())
            elif u.path == "/api/kit":
                try:
                    self.send(200, json.loads(kit_file(q.get("name", "")).read_text(encoding="utf-8")))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path == "/api/character":
                ref, lod = q["ref"], int(q.get("lod", "1"))
                self.send(200, cached("char", f"{ref}|{lod}|2", lambda: character_glb(ref, lod), "glb"), "model/gltf-binary")
            elif u.path == "/api/thumb":
                f = thumb_file(q["path"])
                if f.exists():
                    self.send(200, f.read_bytes(), "image/webp")
                else:
                    self.send(404, {"error": "no thumbnail"})
            elif u.path == "/api/usage":
                self.send(200, model_usage(q["model"]))
            elif u.path == "/api/mods":
                mods = pathlib.Path(casc.GAME) / "mods"
                self.send(200, sorted(p.name for p in mods.iterdir() if p.is_dir() and not p.name.endswith(".old")) if mods.exists() else [])
            elif u.path == "/api/mods/check":
                import modmerge
                mods = pathlib.Path(casc.GAME) / "mods"
                a, b = q.get("a", ""), q.get("b", "")
                if not all(re.fullmatch(r"[A-Za-z0-9 _.-]{1,60}", x) and (mods / x).is_dir() for x in (a, b)):
                    return self.send(400, {"error": "Choose two mods."})
                self.send(200, modmerge.conflicts(mods / a, mods / b))
            elif u.path == "/api/world/free":
                try:
                    taken = json.loads(q.get("taken", "[]"))
                    self.send(200, {"offset": free_offset(int(q["w"]), int(q["h"]), int(q.get("act", 4)), taken)})
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path == "/api/presetinfo2":
                info = preset_info(q["path"])
                w, h = preset_size(q["path"])
                self.send(200, {**info, "size": [w, h]})
            elif u.path == "/api/stamps":  # ground stamp masks of the game
                self.send(200, sorted(k for k in names if k.startswith("data/hd/env/texture/terrain/stamp/") and k.endswith(".texture")))
            elif u.path == "/api/loot":
                try:
                    self.send(200, loot_get(q["name"]) if q.get("name") else loot_list(q.get("q", "")))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path == "/api/play":
                self.send(200, {**play_state, "test": act_test_state})
            elif u.path == "/api/world":
                self.send(200, world_state())
            elif u.path == "/api/projects":
                self.send(200, list_projects())
            elif u.path == "/api/modinfo":
                self.send(200, read_modinfo())
            elif u.path == "/api/check":
                self.send(200, project_check())
            elif u.path == "/api/edited":  # maps saved in the project (edited or new)
                self.send(200, sorted(p.relative_to(PROJECT).as_posix() for p in (PROJECT / "data/hd/env/preset").rglob("*.json"))
                          if (PROJECT / "data/hd/env/preset").exists() else [])
            elif u.path == "/api/npcs":
                self.send(200, npcs_payload())
            elif u.path == "/api/version":
                self.send(200, {"version": updater.current_version()})
            elif u.path == "/api/update":
                self.send(200, updater.public(updater.check(force=q.get("force") == "1")))
            elif u.path == "/api/update/state":
                self.send(200, updater.state)
            elif u.path == "/api/preset":
                self.send(200, read_asset(q["path"], original=q.get("original") == "1"), "application/json")
            elif u.path == "/api/collision":
                self.send(200, collision_payload(ds1_for_preset(q["path"])))
            elif u.path == "/api/links":
                self.send(200, read_links(q["path"]))
            elif u.path == "/api/draft":
                f = draft_file(q["path"])
                if f.exists():
                    import os as _os
                    self.send(200, {"time": _os.path.getmtime(f), "doc": json.loads(f.read_text(encoding="utf-8"))})
                else:
                    self.send(200, {})
            elif u.path == "/api/objects":
                self.send(200, objects_payload(ds1_for_preset(q["path"])))
            elif u.path == "/api/sd":
                png, meta = sd_map(q["path"])
                if q.get("meta"):
                    self.send(200, meta)
                else:
                    self.send(200, png, "image/png")
            elif u.path == "/api/samesize":
                self.send(200, same_size_presets(q["path"]))
            elif u.path == "/api/presetinfo":
                self.send(200, preset_info(q["path"]))
            elif u.path == "/api/test":
                import time as _t
                self.send(200, {**test_state, "elapsed": _t.time() - test_state["started"] if test_state["started"] else 0})
            elif u.path == "/api/models":
                items, total = list_models(q.get("q", ""), int(q.get("limit", "300")), q.get("own") == "1")
                self.send(200, {"items": items, "total": total})
            elif u.path == "/api/model":
                lod = int(q.get("lod", "1"))
                f = model_file(q["path"], lod)
                self.send(200, cached("glb", f + version_key(f), lambda: model_export.convert(read_asset(f)), "glb"), "model/gltf-binary")
            elif u.path == "/api/texture":
                mip = int(q.get("mip", "1"))
                p = q["path"]
                # "|2": texture format table fixed (2026-11-23), older cached PNGs are not used
                self.send(200, cached("png", f"{p}|{mip}|2" + version_key(p.replace("\\", "/").lower().lstrip("/")), lambda: make_png(p, mip), "png"), "image/png")
            else:
                self.send(404, {"error": "not found"})
        except FileNotFoundError as e:
            self.send(404, {"error": f"missing: {e}"})
        except Exception as e:
            traceback.print_exc()
            self.send(500, {"error": str(e)})

    def trusted(self):
        """Changing requests must come from the editor page: other web pages could otherwise send
        them to this local server (cross-site requests). The custom header cannot be sent cross-site
        without a CORS preflight, which this server never allows; the Host check stops DNS rebinding."""
        host = (self.headers.get("Host") or "").split(":")[0]
        return self.headers.get("X-D2R-Editor") == "1" and host in ("127.0.0.1", "localhost")

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        if not self.trusted():
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            return self.send(403, {"error": "forbidden"})
        try:
            if u.path == "/api/update/download":
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                r = updater.download()
                self.send(409 if r["phase"] == "error" else 200, r)
            elif u.path == "/api/update/apply":
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                ok = updater.apply_and_exit()  # the launcher restarts the server with the new version
                self.send(200 if ok else 409, {"restarting": ok})
            elif u.path in ("/api/retexture", "/api/import"):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                try:
                    self.send(200, (make_retexture if u.path.endswith("retexture") else make_import)(body))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path == "/api/npcs":
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                try:
                    self.send(200, save_npcs(body.get("npcs", [])))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path == "/api/export":
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else {}
                if body.get("info"):
                    try:
                        info = write_modinfo(body["info"])
                    except ValueError as e:
                        return self.send(400, {"error": str(e)})
                    name = info["name"]
                else:
                    info, name = None, q.get("name", "D2REditor")
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name):
                    return self.send(400, {"error": "Mod name: only letters, digits, _ and -"})
                self.send(200, export_mod(name, info, bool(body.get("zip"))))
            elif u.path in ("/api/kit", "/api/kit/delete"):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                try:
                    f = kit_file(q.get("name", ""))
                except ValueError as e:
                    return self.send(400, {"error": str(e)})
                if u.path.endswith("delete"):
                    f.unlink(missing_ok=True)
                else:
                    kit = json.loads(body)
                    if not isinstance(kit.get("items"), list) or not kit["items"]:
                        return self.send(400, {"error": "A kit needs at least one object."})
                    KITS.mkdir(parents=True, exist_ok=True)
                    f.write_text(json.dumps(kit, ensure_ascii=False), encoding="utf-8")
                self.send(200, list_kits())
            elif u.path == "/api/thumb":
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                raw = base64.b64decode(body["data"].split(",", 1)[-1])
                if len(raw) > 200_000:
                    return self.send(400, {"error": "too large"})
                f = thumb_file(q["path"])
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(raw)
                self.send(200, {"saved": True})
            elif u.path == "/api/mods/merge":
                import modmerge
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                mods = pathlib.Path(casc.GAME) / "mods"
                a, b, out = q.get("a", ""), q.get("b", ""), q.get("out", "")
                if not all(re.fullmatch(r"[A-Za-z0-9 _.-]{1,60}", x) and (mods / x).is_dir() for x in (a, b)):
                    return self.send(400, {"error": "Choose two mods."})
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", out):
                    return self.send(400, {"error": "Mod name: only letters, digits, _ and -"})
                try:
                    self.send(200, modmerge.merge(mods / a, mods / b, mods / out, lambda p: read_asset(p, original=True), q.get("bwins") == "1"))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path in ("/api/play", "/api/world/test"):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                try:
                    if u.path.endswith("test"):
                        if not world_available():
                            return self.send(409, {"error": f"d2r-world-mods not found ({WORLD})"})
                        self.send(200, act_test())
                    else:
                        self.send(200, play_here(body.get("path", ""), float(body.get("x", 0)), float(body.get("z", 0))))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path == "/api/loot":
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                try:
                    self.send(200, loot_save(body["name"], body.get("fields", {}), bool(body.get("reset"))))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path == "/api/newmap":
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                try:
                    self.send(200, new_map(body.get("template", ""), str(body.get("name", "")).lower(), bool(body.get("empty"))))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path in ("/api/world/spec", "/api/world/build"):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else {}
                if not world_available():
                    return self.send(409, {"error": f"d2r-world-mods not found ({WORLD})"})
                try:
                    if u.path.endswith("spec"):
                        self.send(200, save_act_spec(body))
                    else:
                        name = body.get("export")
                        if name and not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name):
                            return self.send(400, {"error": "Mod name: only letters, digits, _ and -"})
                        self.send(200, build_act(name))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path == "/api/project":
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                try:
                    self.send(200, switch_project(q.get("name", "")))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path == "/api/reveal":
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                EXPORTS.mkdir(parents=True, exist_ok=True)
                import os as _os
                _os.startfile(str(EXPORTS))  # noqa: S606 (fixed local folder)
                self.send(200, {"opened": str(EXPORTS)})
            elif u.path == "/api/collision":
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.send(200, edit_collision(ds1_for_preset(q["path"]), body.get("ops", [])))
            elif u.path == "/api/draft":
                f = draft_file(q["path"])
                body = self.rfile.read(int(self.headers["Content-Length"] or 0))
                if body:
                    json.loads(body)
                    f.parent.mkdir(parents=True, exist_ok=True)
                    f.write_bytes(body)
                elif f.exists():
                    f.unlink()  # empty body: discard the draft
                self.send(200, {"ok": True})
            elif u.path == "/api/objects":
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.send(200, edit_objects(ds1_for_preset(q["path"]), body.get("objects", [])))
            elif u.path in ("/api/collision/undo", "/api/collision/redo"):
                fn = undo_collision if u.path.endswith("undo") else redo_collision
                r = fn(ds1_for_preset(q["path"]))
                self.send(200, r) if r else self.send(409, {"error": "nothing to undo/redo"})
            elif u.path == "/api/links":
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                write_links(q["path"], body)
                self.send(200, {"saved": True})
            elif u.path == "/api/test":
                name = q.get("name", "D2REditor")
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name):
                    return self.send(400, {"error": "Mod name: only letters, digits, _ and -"})
                r = start_ingame_test(name)
                self.send(409 if "error" in r else 200, r)
            elif u.path == "/api/replace":
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                try:
                    self.send(200, replace_preset(q["path"], q["source"]))
                except ValueError as e:
                    self.send(400, {"error": str(e)})
            elif u.path == "/api/preset":
                key = q["path"].replace("\\", "/").lower().lstrip("/")
                if not key.startswith("data/hd/env/preset/") or ".." in key:
                    return self.send(400, {"error": "bad path"})
                body = self.rfile.read(int(self.headers["Content-Length"]))
                json.loads(body)  # must be valid JSON
                dst = PROJECT / key
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(body)
                draft_file(key).unlink(missing_ok=True)  # saved: the draft is no longer needed
                self.send(200, {"saved": str(dst)})
            else:
                self.rfile.read(int(self.headers.get("Content-Length") or 0))  # drain, keep the connection sane
                self.send(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            self.send(500, {"error": str(e)})

    def static(self, p):
        p = p.resolve()
        if not str(p).startswith(str(WEB.resolve())) or not p.is_file():
            return self.send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if p.suffix == ".js":
            ctype = "text/javascript"
        self.send(200, p.read_bytes(), ctype)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"D2R editor on http://127.0.0.1:{port}/  ({len(names)} assets)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
