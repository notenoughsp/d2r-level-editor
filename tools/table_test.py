"""Does the game read data tables (data/global/excel) from a mod? python -I tools/table_test.py <mod>

Writes a levels.txt with the Blood Moor (level 2) shrunk to 40 x 40 tiles into the mod, starts the
game once without and once with -txt, reads the Blood Moor's room layout with the test plugin and
compares its size with the original 80 x 80. Removes the changed table again afterwards.
"""
import shutil
import subprocess
import sys
import time
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import explore  # noqa: E402
import ingame_test as it  # noqa: E402


def shrunk_levels(name):
    raw = it.read_asset(name, original=True).decode("latin1")
    nl = "\r\n" if "\r\n" in raw else "\n"
    rows = [r.split("\t") for r in raw.split(nl)]
    h = rows[0]
    for r in rows[1:]:
        if len(r) > h.index("Id") and r[h.index("Id")] == "2":
            for k in ("SizeX", "SizeY", "SizeX(N)", "SizeY(N)", "SizeX(H)", "SizeY(H)"):
                r[h.index(k)] = "40"
    return nl.join("\t".join(r) for r in rows).encode("latin1")


def run(mod, extra_args):
    pd = it.GAME / "mods" / mod / "d2rloader" / "plugins"
    start = time.time()
    for f in list(pd.glob("run_*.txt")) + list(pd.glob("levels_*.txt")) + [pd / "done.txt", pd / "moves.txt"]:
        f.unlink(missing_ok=True)
    shutil.copy2(it.HARNESS, pd / it.HARNESS.name)
    (pd / "test-harness.ini").write_text("runs=1\nradius=20\nsettle_ticks=100\nwindow_x=-3840\nwindow_y=0\n"
                                         "window_w=1600\nwindow_h=900\nvary_game_seed=0\nlevels=2\n")
    proc = subprocess.Popen([str(it.GAME / "D2RLoader.exe"), "-mod", mod] + extra_args, cwd=str(it.GAME))
    explore.finish(proc, pd, start)
    rooms = explore.read_levels(pd / "levels_0.txt").get(2, []) if (pd / "levels_0.txt").exists() else []
    if not rooms:
        return "no layout logged"
    xs = [x for x, y, w, h in rooms] + [x + w for x, y, w, h in rooms]
    ys = [y for x, y, w, h in rooms] + [y + h for x, y, w, h in rooms]
    return f"{len(rooms)} rooms, {max(xs) - min(xs)} x {max(ys) - min(ys)} tiles"


def main():
    mod = sys.argv[1] if len(sys.argv) > 1 else "D2REditorTest"
    root = it.GAME / "mods" / mod / f"{mod}.mpq" / "data" / "global" / "excel"
    targets = [root / "levels.txt", root / "base" / "levels.txt"]
    print("original:", run(mod, []))
    try:
        for t in targets:
            t.parent.mkdir(parents=True, exist_ok=True)
            t.write_bytes(shrunk_levels("data/global/excel/" + t.relative_to(root).as_posix()))
        print("mod levels.txt:", run(mod, []))
        print("mod levels.txt with -txt:", run(mod, ["-txt"]))
    finally:
        for t in targets:
            t.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
