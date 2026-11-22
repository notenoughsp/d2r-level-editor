"""D2R level editor backend: serves the web editor and game assets straight from CASC.

  python -I server.py [port]      then open http://127.0.0.1:8765/

Read-only towards the game: assets are read from the CASC storage through CascLib.
Edited presets are written to project/<preset path> and can be exported into a mod.
"""
import hashlib
import io
import json
import mimetypes
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


def install_world_plugin(mod):
    """New levels (zones/*.json, built with tools/new_zone.py) need the d2r-world plugin: extra
    towns and coming back to the new areas after leaving the game. Its config comes from the zones."""
    zones = [json.loads(p.read_text(encoding="utf-8")) for p in sorted((DATA / "zones").glob("*.json"))]
    zones = [z for z in zones if (PROJECT / "data/global/excel/levels.txt").exists()]
    pdir = mod / "d2rloader" / "plugins"
    if not zones:
        (pdir / "d2r-world.dll").unlink(missing_ok=True)
        (pdir / "d2r-world.ini").unlink(missing_ok=True)
        return
    towns = [z["level"]["id"] for z in zones if z["level"].get("town")]
    world = [z["level"]["id"] for z in zones]
    pdir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "plugin" / "d2r-world.dll", pdir / "d2r-world.dll")
    lines = ["; written by the editor export from zones/*.json",
             f"towns={','.join(map(str, towns))}", f"world={','.join(map(str, world))}",
             f"hub={towns[0] if towns else world[0]}", "hub_warp_type=0", "return_delay_frames=40"]
    (pdir / "d2r-world.ini").write_text("\n".join(lines) + "\n")


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
    # model from a new folder (black ground, see tools/new_zone.py); both pieces have the same size.
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
    lines = read_asset(f"data/global/excel/{name}.txt").decode("latin1").splitlines()  # project tables too (new zones)
    head = lines[0].split("\t")
    return [dict(zip(head, l.split("\t"))) for l in lines[1:] if l.strip()]


_preset_index = None


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
    clean = []
    for ob in new_objects:
        x, y = int(ob["x"]), int(ob["y"])
        if not (0 <= x < d.width * 5 and 0 <= y < d.height * 5):
            raise ValueError(f"Game object outside the map: subtile {x}, {y} (map: {d.width * 5} x {d.height * 5})")
        frm = tuple(ob.get("from") or (x, y))
        if ob.get("type") == 1:
            moved[frm] = (x, y)
        clean.append({"type": int(ob["type"]), "id": int(ob["id"]), "x": x, "y": y, "flags": int(ob.get("flags", 0))})
    paths = []
    for p in o.paths:
        key = (p["x"], p["y"])
        if key not in moved:
            continue  # its NPC was removed
        nx, ny = moved[key]
        dx, dy = nx - p["x"], ny - p["y"]
        paths.append({"x": nx, "y": ny, "nodes": [[n[0] + dx, n[1] + dy] + n[2:] for n in p["nodes"]]})
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
    collision.apply_ops(d, ops, subtiles)
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


def model_file(vpath, lod):
    key = vpath.replace("\\", "/").lower()
    if re.search(r"_lod\d\.model$", key) and key in names:
        return key
    base = key[:-len(".model")] if key.endswith(".model") else key
    for l in [lod, 0, 1, 2]:
        cand = f"{base}_lod{l}.model"
        if cand in names:
            return cand
    if key in names:
        return key
    raise FileNotFoundError(vpath)


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


def list_models(q, limit):
    seen = []
    ql = q.lower()
    for k in names:
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


def export_mod(name):
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
    plugin = ROOT / "plugin" / "d2r-fixed-seed.dll"
    if plugin.exists():
        pdir = mod / "d2rloader" / "plugins"
        pdir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(plugin, pdir / plugin.name)
    install_world_plugin(mod)
    meta = mod / "d2rloader" / "metadata.json"
    meta.parent.mkdir(parents=True, exist_ok=True)
    meta.write_text(json.dumps({"schemaVersion": 1, "d2rloader": {"version": "1.3.1-beta"},
                                "metadata": {"name": name, "author": "D2R Level Editor", "modVersion": "0.1.0",
                                             "description": "HD level edits made with the D2R level editor.",
                                             "website": ""}}, indent=2))
    return {"mod": str(mod), "files": len(files)}


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
            elif u.path == "/api/preset":
                self.send(200, read_asset(q["path"]), "application/json")
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
                items, total = list_models(q.get("q", ""), int(q.get("limit", "300")))
                self.send(200, {"items": items, "total": total})
            elif u.path == "/api/model":
                lod = int(q.get("lod", "1"))
                f = model_file(q["path"], lod)
                self.send(200, cached("glb", f, lambda: model_export.convert(read_asset(f)), "glb"), "model/gltf-binary")
            elif u.path == "/api/texture":
                mip = int(q.get("mip", "1"))
                p = q["path"]
                self.send(200, cached("png", f"{p}|{mip}", lambda: make_png(p, mip), "png"), "image/png")
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
            if u.path == "/api/export":
                name = q.get("name", "D2REditor")
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name):
                    return self.send(400, {"error": "Mod name: only letters, digits, _ and -"})
                self.send(200, export_mod(name))
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
