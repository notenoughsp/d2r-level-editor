"""Build the wave survival mod: python -I tools/survival_mod.py [mod name] [options]

  --keep-monsters      keep the normal monster population (default: the plugin turns it off
                       outside the towns, so only the waves bring monsters)
  --savepath <folder>  save folder of the mod (default: the mod name)
  --into <mod>         add the survival plugin to an existing mod (e.g. one exported by the editor)
  --first <s> --break <s> --base <n> --per-wave <n>   wave settings for d2r-survival.ini

Writes <game>/mods/<name>/:
  <name>.mpq/modinfo.json
  d2rloader/plugins/d2r-survival.dll + d2r-survival.ini (monster list of every level from levels.txt)
  d2rloader/metadata.json
"""
import json
import pathlib
import shutil
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import casc  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin" / "d2r-survival.dll"
TOWNS = {1, 40, 75, 103, 109}


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def read_table(c, name):
    raw = c.read(f"data:data\\global\\excel\\{name}.txt").decode("latin1")
    lines = raw.split("\r\n") if "\r\n" in raw else raw.split("\n")
    return [l.split("\t") for l in lines]


def main():
    with_value = {"--savepath", "--into", "--first", "--break", "--base", "--per-wave"}
    args = [a for i, a in enumerate(sys.argv[1:], 1)
            if not a.startswith("--") and sys.argv[i - 1] not in with_value]
    into = arg("--into")
    name = into or (args[0] if args else "D2RSurvival")
    mod = pathlib.Path(casc.GAME) / "mods" / name
    c = casc.Casc()

    stats = read_table(c, "monstats")
    row_of = {r[0].lower(): i for i, r in enumerate(stats[1:]) if r and r[0]}
    levels = read_table(c, "levels")
    head = levels[0]
    col = {h: i for i, h in enumerate(head)}
    ini = [f"first_wave_seconds={arg('--first', 6)}", f"break_seconds={arg('--break', 8)}",
           "wave_timeout_seconds=90", f"base_count={arg('--base', 6)}", f"per_wave={arg('--per-wave', 3)}",
           "max_alive=80", "radius_min=10", "radius_max=18",
           f"normal_monsters={1 if '--keep-monsters' in sys.argv else 0}"]
    waved = 0
    for r in levels[1:]:
        if len(r) < len(head) or not r[col["Id"]].isdigit():
            continue
        lid = int(r[col["Id"]])
        if lid in TOWNS or lid == 0:
            continue
        mons = []
        for k in range(1, 26):
            for prefix in ("mon", "nmon"):
                v = r[col[f"{prefix}{k}"]].strip().lower()
                if v and v in row_of and row_of[v] not in mons:
                    mons.append(row_of[v])
        if mons:
            ini.append(f"level_{lid}=" + ",".join(map(str, mons)))
            waved += 1

    if not into:
        data_root = mod / f"{name}.mpq"
        data_root.mkdir(parents=True, exist_ok=True)
        (data_root / "modinfo.json").write_text(json.dumps({"name": name, "savepath": arg("--savepath", name) + "/"}, indent=2))
        meta = mod / "d2rloader" / "metadata.json"
        meta.parent.mkdir(parents=True, exist_ok=True)
        meta.write_text(json.dumps({"schemaVersion": 1, "d2rloader": {"version": "1.3.1-beta"},
                                    "metadata": {"name": name, "author": "D2R Level Editor", "modVersion": "0.1.0",
                                                 "description": "Wave survival: monsters come in growing waves outside the towns.",
                                                 "website": ""}}, indent=2))
    else:
        data_root = mod / f"{name}.mpq"
        if not data_root.exists():
            sys.exit(f"mod {name} not found")
    # an earlier version wrote a levels.txt with monster density 0; this game build does not read
    # excel files from mods, so the plugin turns the normal population off instead
    (data_root / "data" / "global" / "excel" / "levels.txt").unlink(missing_ok=True)
    pdir = mod / "d2rloader" / "plugins"
    pdir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(PLUGIN, pdir / PLUGIN.name)
    (pdir / "d2r-survival.ini").write_text("\n".join(ini) + "\n")
    print(f"{mod}: {waved} levels with waves, normal monsters "
          f"{'kept' if '--keep-monsters' in sys.argv else 'removed'}")


if __name__ == "__main__":
    main()
