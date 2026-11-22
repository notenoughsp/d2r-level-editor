"""Build a new level (zone) from a description: python -I tools/new_zone.py zones/<zone>.json

The game build reads data tables (data/global/excel/*.txt) and string tables from a mod and
compiles them at start (D2RLoader TXT compiler; no -txt needed). A new level therefore needs:

  levels.txt     a new row (copied from a template level: id, act, world offset, waypoint bit)
  lvlprest.txt   a new row that gives the level its map piece (one DS1 file)
  the DS1        a copy of a template piece, with its game objects replaced (combined_ds1.bin
                 gets the new entry on export)
  the HD preset  a copy of the template's preset JSON and terrain files, cleaned and decorated
  levels.json    the level's names (data/local/lng/strings)

Everything is written into project/ and goes into the mod with the editor's export. Running the
script again rebuilds the zone from the description (the rows are replaced, not added twice).
Level ids above 137 and the waypoint bit 39 (the last free one of 40) are the new ones.
"""
import json
import math
import pathlib
import re
import shutil
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import ingame_test as it  # noqa: E402
from ds1 import DS1, Ds1Objects  # noqa: E402

PROJECT = it.PROJECT


def table(name):
    """Rows of a data table: the project's copy if there is one (other zones), else the original."""
    raw = it.read_asset(f"data/global/excel/{name}.txt").decode("latin1")
    nl = "\r\n" if "\r\n" in raw else "\n"
    rows = [r.split("\t") for r in raw.split(nl)]
    while rows and rows[-1] == [""]:
        rows.pop()
    return rows, nl


def write_table(name, rows, nl):
    dst = PROJECT / f"data/global/excel/{name}.txt"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes((nl.join("\t".join(r) for r in rows) + nl).encode("latin1"))


def add_level_row(spec):
    rows, nl = table("levels")
    h = rows[0]
    col = {k: i for i, k in enumerate(h)}
    lv = spec["level"]
    tpl = next(r for r in rows[1:] if len(r) > col["Id"] and r[col["Id"]] == str(lv["template_id"]))
    row = list(tpl) + [""] * (len(h) - len(tpl))
    row[col["Name"]] = lv["name"]
    row[col["*StringName"]] = lv["string_key"]
    row[col["Id"]] = str(lv["id"])
    row[col["Act"]] = str(lv["act"])
    row[col["OffsetX"]], row[col["OffsetY"]] = map(str, lv["offset"])
    row[col["Waypoint"]] = str(lv.get("waypoint", 255))
    row[col["LevelName"]] = lv["string_key"]
    row[col["LevelWarp"]] = "To " + lv["string_key"]
    row[col["LevelEntry"]] = "Entering " + lv["string_key"]
    if lv.get("no_monsters"):
        for k in h:
            if re.fullmatch(r"(n|u)?mon\d+|MonUMin.*|MonUMax.*|MonDen.*|NumMon|MonWndr|MonSpcWalk", k):
                row[col[k]] = "0" if k.startswith(("MonU", "MonDen", "NumMon", "MonWndr", "MonSpc")) else ""
    for k, v in lv.get("set", {}).items():
        row[col[k]] = v
    rows = [r for r in rows if not (len(r) > col["Id"] and r[col["Id"]] == str(lv["id"]))]
    # keep the "Expansion" marker rows where they are; new levels go to the end (ids must stay in order)
    rows.append(row)
    write_table("levels", rows, nl)


def add_lvlprest_row(spec, ds1_name):
    rows, nl = table("lvlprest")
    h = rows[0]
    col = {k: i for i, k in enumerate(h)}
    tpl = next(r for r in rows[1:] if r and r[0] == spec["preset"]["lvlprest_template"])
    lv = spec["level"]
    rows = [r for r in rows if not (len(r) > col["LevelId"] and r[col["LevelId"]] == str(lv["id"]))]
    defs = [int(r[col["Def"]]) for r in rows[1:] if len(r) > col["Def"] and r[col["Def"]].isdigit()]
    row = list(tpl) + [""] * (len(h) - len(tpl))
    row[col["Name"]] = lv["name"]
    row[col["Def"]] = str(max(defs) + 1)
    row[col["LevelId"]] = str(lv["id"])
    row[col["Populate"]] = spec["preset"].get("populate", row[col["Populate"]])
    row[col["Files"]] = "1"
    row[col["File1"]] = ds1_name
    for i in range(2, 7):
        row[col[f"File{i}"]] = "0"
    rows.append(row)
    write_table("lvlprest", rows, nl)


def add_strings(spec):
    # level names: the game has a current and a legacy string table; both get the new names
    for path in ("data/local/lng/strings/levels.json", "data/local/lng/strings-legacy/levels.json"):
        add_strings_to(spec, path)


def add_strings_to(spec, path):
    data = json.loads(it.read_asset(path).decode("utf-8-sig"))
    keys = set(spec["strings"])
    data = [e for e in data if e.get("Key") not in keys]
    next_id = max(e["id"] for e in data) + 1
    for key, texts in spec["strings"].items():
        entry = {"id": next_id, "Key": key}
        for lang in ("enUS", "zhTW", "deDE", "esES", "frFR", "itIT", "koKR", "plPL", "esMX", "jaJP", "ptBR", "ruRU", "zhCN"):
            entry[lang] = texts.get(lang, texts.get("enUS", key))
        data.append(entry)
        next_id += 1
    dst = PROJECT / path
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8-sig")


def ring(center, radius, count, start=0.0):
    for i in range(count):
        a = math.radians(start + 360.0 * i / count)
        yield center[0] + radius * math.cos(a), center[1] + radius * math.sin(a), a


def model_entity(template, name, eid, model, x, z, yaw, scale):
    e = {"type": "Entity", "name": name, "id": eid, "components": []}
    for c in template["components"]:
        if c["type"] == "TransformDefinitionComponent":
            t = json.loads(json.dumps(c))
            t["name"] = name + "_TransformDefinitionComponent"
            t["position"] = {"x": x, "y": 0.0, "z": z}
            t["orientation"] = {"x": 0.0, "y": math.sin(yaw / 2), "z": 0.0, "w": math.cos(yaw / 2)}
            t["scale"] = {"x": scale, "y": scale, "z": scale}
            e["components"].append(t)
        elif c["type"] == "ModelDefinitionComponent":
            m = json.loads(json.dumps(c))
            m["name"] = name + "_ModelDefinitionComponent"
            m["filename"] = model
            e["components"].append(m)
    return e


def build_preset(spec):
    src, dst = spec["preset"]["template"], spec["preset"]["path"]
    src_dir, dst_dir = src[:-5] + "/", dst[:-5] + "/"
    # The terrain mesh and physics stay at the template's paths: the game loads new JSON files
    # from a mod, but a terrain model in a new folder stayed invisible (2026-11-22, black ground).
    # The new map has the template's shape, so the template's terrain fits.
    j = json.loads(it.read_asset(src).decode("utf-8"))
    design = spec["design"]
    rm_model = re.compile(design["remove_models"], re.I)
    rm_vfx = re.compile(design["remove_vfx"], re.I)
    center = None
    kept = []
    removed = 0
    for e in j["entities"]:
        files = [c.get("filename") or "" for c in e["components"]]
        model = next((c.get("filename") for c in e["components"] if c.get("type") == "ModelDefinitionComponent"), None)
        vfx = any(c.get("type") == "VfxDefinitionComponent" for c in e["components"])
        if model and design["center"] in model and center is None:
            pos = next(c["position"] for c in e["components"] if c["type"] == "TransformDefinitionComponent")
            center = (pos["x"], pos["z"])
        decal = any(c.get("type") == "DecalDefinitionComponent" for c in e["components"])
        rm_decal = re.compile(design.get("remove_decals", "$^"), re.I)
        if ((model and rm_model.search(model.split("/")[-1])) or (vfx and rm_vfx.search(e["name"] + " ".join(files)))
                or (decal and rm_decal.search(e["name"]))):
            removed += 1
            continue
        kept.append(e)
    template = next(e for e in kept if any(c.get("type") == "ModelDefinitionComponent" for c in e["components"])
                    and len(e["components"]) == 2)
    eid = max(e["id"] for e in kept) + 1
    added = 0
    models = set()
    for m in design["models"]:
        r = m["ring"]
        for i, (x, z, a) in enumerate(ring(center, r["radius"], r["count"], r.get("start", 0.0))):
            kept.append(model_entity(template, f"zone_{m['what'].replace(' ', '_')}_{i}", eid, m["model"],
                                     round(x, 2), round(z, 2), a + math.pi / 2, m.get("scale", 1.0)))
            eid += 1
            added += 1
        models.add(m["model"])
    j["entities"] = kept
    deps = j.setdefault("dependencies", {}).setdefault("models", [])
    for m in sorted(models):
        if {"path": m} not in deps:
            deps.append({"path": m})
    out = PROJECT / dst
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(j, indent=1), encoding="utf-8")
    old = PROJECT / dst_dir  # copies made by an earlier version of this script
    if old.exists():
        shutil.rmtree(old)
    return center, removed, added


def build_ds1(spec, center_hd):
    src = spec["preset"]["template"].replace("data/hd/env/preset/", "data/global/tiles/")[:-5] + ".ds1"
    dst = spec["preset"]["path"].replace("data/hd/env/preset/", "data/global/tiles/")[:-5] + ".ds1"
    d = DS1(it.read_asset(src))
    objs = Ds1Objects(d)
    if not objs.editable:
        raise SystemExit(f"{src}: objects cannot be written")
    cx, cy = round(center_hd[0] / 2), round(center_hd[1] / 2)  # HD units -> subtiles
    new = []
    for o in spec["design"]["objects"]:
        spots = ([(cx + x, cy + y) for x, y, _ in ring((0, 0), o["ring"]["radius"], o["ring"]["count"])]
                 if "ring" in o else [(cx + o["at"][0], cy + o["at"][1])])
        for x, y in spots:
            new.append({"type": 2, "id": o["id"], "x": int(round(x)), "y": int(round(y)), "flags": 0})
    objs.objects = new
    objs.paths = []
    d.tail = objs.to_tail()
    out = PROJECT / dst
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(d.to_bytes())
    act_dir = dst.split("/")[3]  # data/global/tiles/<act>/...
    return "/".join(p.capitalize() if i == 0 else p for i, p in enumerate(dst.split("/")[3:])), len(new), act_dir


def main():
    spec = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    center, removed, added = build_preset(spec)
    ds1_name, nobj, _ = build_ds1(spec, center)
    add_level_row(spec)
    add_lvlprest_row(spec, ds1_name)
    add_strings(spec)
    lv = spec["level"]
    print(f"level {lv['id']} '{lv['name']}' (act index {lv['act']}, waypoint bit {lv.get('waypoint')}): "
          f"map {ds1_name}, preset {spec['preset']['path']}")
    print(f"design: centre {center}, {removed} entities removed, {added} models added, {nobj} game objects")


if __name__ == "__main__":
    main()
