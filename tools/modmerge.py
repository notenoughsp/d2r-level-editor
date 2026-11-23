"""Check two exported mods for files they both change, and merge them into a new mod.

A mod folder (<game>/mods/<Name>/) holds <Name>.mpq/ (game files) and d2rloader/ (plugins and
metadata). Two mods clash where both carry the same game file with different content:

  data tables (data/global/excel/*.txt)  merged row by row against the game's original table:
                                          rows changed by one mod are taken over, new rows of
                                          both are kept; a row both changed differently clashes
  string files (data/local/lng/**.json)  merged by Key in the same way
  everything else                        clashes (the second mod can win if asked)

Merged tables keep both mods' new rows; ids inside them (level ids, string ids) may still collide
and are reported as warnings.
"""
import json
import pathlib
import shutil

TABLE_DIR = "data/global/excel/"


def mod_files(mod):
    """{key: path}; game files as mpq/<path>, the rest as <path> relative to the mod folder."""
    mod = pathlib.Path(mod)
    mpq = mod / f"{mod.name}.mpq"
    out = {}
    for p in mod.rglob("*"):
        if not p.is_file() or p.suffix in (".log", ".old"):
            continue
        if mpq in p.parents:
            rel = p.relative_to(mpq).as_posix().lower()
            if rel == "modinfo.json":
                continue  # each mod has its own
            out["mpq/" + rel] = p
        else:
            rel = p.relative_to(mod).as_posix().lower()
            if rel in ("d2rloader/metadata.json",) or rel.endswith(".txt") and rel.startswith("d2rloader/plugins/"):
                continue  # metadata and plugin state files
            out[rel] = p
    return out


def kind_of(key):
    if key.startswith("mpq/" + TABLE_DIR) and key.endswith(".txt"):
        return "table"
    if key.startswith("mpq/data/local/lng/") and key.endswith(".json"):
        return "strings"
    return "file"


def conflicts(mod_a, mod_b):
    fa, fb = mod_files(mod_a), mod_files(mod_b)
    out = []
    for key in sorted(set(fa) & set(fb)):
        if fa[key].read_bytes() == fb[key].read_bytes():
            continue
        out.append({"file": key.removeprefix("mpq/"), "kind": kind_of(key)})
    return {"a_files": len(fa), "b_files": len(fb), "conflicts": out}


# ---------------------------------------------------------------- tables
def _rows(raw):
    text = raw.decode("latin1")
    nl = "\r\n" if "\r\n" in text else "\n"
    rows = [r.split("\t") for r in text.split(nl)]
    while rows and rows[-1] == [""]:
        rows.pop()
    return rows, nl


def merge_table(orig, a, b, b_wins):
    """Three-way merge of tab-separated tables by their first column (several rows may share a
    key, e.g. "Expansion" markers: they are matched in order)."""
    (ro, nl), (ra, _), (rb, _) = _rows(orig), _rows(a), _rows(b)
    warnings, clashes = [], []

    def keyed(rows):
        seen, out = {}, []
        for r in rows[1:]:
            k = r[0] if r else ""
            n = seen.get(k, 0)
            seen[k] = n + 1
            out.append(((k, n), r))
        return out
    o, ka, kb = keyed(ro), dict(keyed(ra)), dict(keyed(rb))
    om = dict(o)
    head = ra[0] if ra[0] != ro[0] else rb[0]
    merged = []
    for key, row in o:
        va, vb = ka.get(key), kb.get(key)
        ca, cb = va != row, vb != row
        if ca and cb and va != vb:
            if not b_wins:
                clashes.append(key[0])
            merged.append(vb if b_wins else va)
        elif cb:
            merged.append(vb)
        elif ca:
            merged.append(va)
        else:
            merged.append(row)
        if merged[-1] is None:  # removed by a mod
            merged.pop()
    new_a = [r for k, r in keyed(ra) if k not in om]
    new_b = [r for k, r in keyed(rb) if k not in om and r not in new_a]
    if new_a and new_b:
        warnings.append(f"both mods add rows ({len(new_a)} + {len(new_b)}); check ids in them")
    rows = [head] + merged + new_a + new_b
    return (nl.join("\t".join(r) for r in rows) + nl).encode("latin1"), clashes, warnings


def merge_strings(orig, a, b, b_wins):
    def load(raw):
        return json.loads(raw.decode("utf-8-sig"))
    lo, la, lb = load(orig), load(a), load(b)
    om = {e.get("Key"): e for e in lo}
    ma, mb = {e.get("Key"): e for e in la}, {e.get("Key"): e for e in lb}
    clashes, out = [], []
    for k, e in om.items():
        va, vb = ma.get(k, e), mb.get(k, e)
        if va != e and vb != e and va != vb:
            if not b_wins:
                clashes.append(k)
            out.append(vb if b_wins else va)
        else:
            out.append(vb if vb != e else va)
    added = [e for k, e in ma.items() if k not in om] + [e for k, e in mb.items() if k not in om and k not in ma]
    ids = [e.get("id") for e in added]
    warnings = ["two new strings share an id"] if len(ids) != len(set(ids)) else []
    return json.dumps(out + added, ensure_ascii=False, indent=2).encode("utf-8-sig"), clashes, warnings


def merge(mod_a, mod_b, out_dir, read_original, b_wins=False):
    """Write the merged mod to out_dir (a new folder). read_original(game path) -> bytes."""
    mod_a, mod_b, out_dir = pathlib.Path(mod_a), pathlib.Path(mod_b), pathlib.Path(out_dir)
    if out_dir.exists():
        raise ValueError(f"{out_dir.name} exists already; choose another name.")
    fa, fb = mod_files(mod_a), mod_files(mod_b)
    report = {"clashes": [], "warnings": [], "merged": []}
    plan = {}
    for key in set(fa) | set(fb):
        pa, pb = fa.get(key), fb.get(key)
        if pa and pb and pa.read_bytes() != pb.read_bytes():
            kind = kind_of(key)
            game_path = key.removeprefix("mpq/")
            if kind in ("table", "strings"):
                try:
                    orig = read_original(game_path)
                except FileNotFoundError:
                    orig = None
                if orig is not None:
                    fn = merge_table if kind == "table" else merge_strings
                    data, clashes, warns = fn(orig, pa.read_bytes(), pb.read_bytes(), b_wins)
                    report["clashes"] += [f"{game_path}: {c}" for c in clashes]
                    report["warnings"] += [f"{game_path}: {w}" for w in warns]
                    report["merged"].append(game_path)
                    plan[key] = data
                    continue
            if not b_wins:
                report["clashes"].append(game_path)
            plan[key] = pb
        else:
            plan[key] = pa or pb
    if report["clashes"]:
        return report  # nothing written
    name = out_dir.name
    for key, src in plan.items():
        dst = out_dir / (f"{name}.mpq/" + key[4:] if key.startswith("mpq/") else key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(src, bytes):
            dst.write_bytes(src)
        else:
            shutil.copy2(src, dst)
    (out_dir / f"{name}.mpq").mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.mpq" / "modinfo.json").write_text(json.dumps({"name": name, "savepath": f"{name}/"}, indent=2))
    meta = out_dir / "d2rloader" / "metadata.json"
    meta.parent.mkdir(parents=True, exist_ok=True)
    meta.write_text(json.dumps({"schemaVersion": 1, "d2rloader": {"version": "1.3.1-beta"},
                                "metadata": {"name": name, "author": "D2R Level Editor", "modVersion": "1.0.0",
                                             "description": f"{mod_a.name} and {mod_b.name}, merged.", "website": ""}}, indent=2))
    report["written"] = str(out_dir)
    return report
