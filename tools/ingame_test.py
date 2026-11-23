"""Unattended in-game test of an exported editor mod. No mouse, keyboard or screenshots.

  python -I ingame_test.py [mod name] [runs]

1. Installs plugin/d2r-test-harness.dll (+ test-harness.ini) into mods/<mod>/d2rloader/plugins.
2. Starts D2RLoader.exe -mod <mod>. The plugin puts the window on the second monitor, enters a
   game with the selected character, logs the server collision around the player and the game
   seed (run_<n>.txt), leaves the game, repeats, and exits the game.
3. Removes the harness again and evaluates:
   - fixed seed: all runs produce the same map (same player spawn and collision)
   - collision: every edited preset (project/data/global/tiles/**.ds1) is located in the dump by
     cross-correlation with its expected collision grid; each edited tile is checked for being
     blocked (or free) in the game as the editor says.
Writes the report to stdout and to assets/ingame_test_report.txt.
"""
import math
import pathlib
import re
import shutil
import subprocess
import sys
import time

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import casc  # noqa: E402
import collision  # noqa: E402
from ds1 import DS1  # noqa: E402

GAME = pathlib.Path(casc.GAME)
PROJECT = casc.DATA / "project"
MOD = sys.argv[1] if len(sys.argv) > 1 else "D2REditorTest"
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 3
PLUGIN_DIR = GAME / "mods" / MOD / "d2rloader" / "plugins"
HARNESS = ROOT / "plugin" / "d2r-test-harness.dll"
TIMEOUT = 15 * 60


def run_game(runs=RUNS, moves=None):
    for f in list(PLUGIN_DIR.glob("run_*.txt")) + list(PLUGIN_DIR.glob("units_*.txt")) + [PLUGIN_DIR / "done.txt", PLUGIN_DIR / "harness.log",
                                                   PLUGIN_DIR / "moves.txt"]:
        f.unlink(missing_ok=True)
    if moves:
        (PLUGIN_DIR / "moves.txt").write_text("".join(f"{x} {y}\n" for x, y in moves))
    shutil.copy2(HARNESS, PLUGIN_DIR / HARNESS.name)
    (PLUGIN_DIR / "test-harness.ini").write_text(
        f"runs={runs}\nradius=150\nsettle_ticks=100\nwindow_x=-3840\nwindow_y=0\nwindow_w=1600\nwindow_h=900\n"
        "start_level=1\n")  # the town test needs the act 1 town, wherever the character was saved
    try:
        proc = subprocess.Popen([str(GAME / "D2RLoader.exe"), "-mod", MOD], cwd=str(GAME))
        start = time.time()
        while proc.poll() is None and time.time() - start < TIMEOUT:
            if (PLUGIN_DIR / "done.txt").exists():
                break
            time.sleep(2)
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        return time.time() - start
    finally:
        time.sleep(1)
        (PLUGIN_DIR / HARNESS.name).unlink(missing_ok=True)


def load_dump(p):
    lines = p.read_text().splitlines()
    head = {l.split()[0]: list(map(int, l.split()[1:])) for l in lines[:4]}
    rows = lines[4:4 + head["size"][1]]
    grid = np.zeros((len(rows), head["size"][0]), dtype=np.int8)  # +1 blocked, -1 free, 0 unknown
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            grid[y, x] = 1 if ch == "#" else -1 if ch == "." else 0
    return head, grid


def read_asset(vpath, original=False):
    key = vpath.replace("\\", "/").lower()
    p = PROJECT / key
    if p.exists() and not original:
        return p.read_bytes()
    return _casc().read(_names()[key])


_c = _n = None


def _casc():
    global _c
    _c = _c or casc.Casc()
    return _c


def _names():
    global _n
    if _n is None:
        _n = {}
        for line in (casc.DATA / "assets" / "listing.tsv").read_text(encoding="utf-8").splitlines()[1:]:
            name, size, avail = line.split("\t")
            if avail == "1" and name.lower().startswith("data:"):
                _n[name[5:].replace("\\", "/").lower()] = name
    return _n


def correlate(dump, expected):
    """Best offset (oy, ox) of expected inside dump by FFT cross-correlation of +1/-1 grids."""
    H = dump.shape[0] + expected.shape[0]
    W = dump.shape[1] + expected.shape[1]
    fa = np.fft.rfft2(dump.astype(np.float32), (H, W))
    fb = np.fft.rfft2(expected[::-1, ::-1].astype(np.float32), (H, W))
    corr = np.fft.irfft2(fa * fb, (H, W))
    iy, ix = np.unravel_index(np.argmax(corr), corr.shape)
    return iy - expected.shape[0] + 1, ix - expected.shape[1] + 1, corr[iy, ix]


def same_world(a, b, min_overlap=5000):
    """Two map logs show the same map: equal on every subtile both know, aligned in world space."""
    (ha, ga), (hb, gb) = a, b
    ax, ay = ha["origin"]
    bx, by = hb["origin"]
    x0, y0 = max(ax, bx), max(ay, by)
    x1, y1 = min(ax + ga.shape[1], bx + gb.shape[1]), min(ay + ga.shape[0], by + gb.shape[0])
    if x1 <= x0 or y1 <= y0:
        return False
    sa = ga[y0 - ay:y1 - ay, x0 - ax:x1 - ax]
    sb = gb[y0 - by:y1 - by, x0 - bx:x1 - bx]
    known = (sa != 0) & (sb != 0)
    return int(known.sum()) >= min_overlap and bool((sa[known] == sb[known]).all())


def evaluate():
    out = []
    dumps = sorted(PLUGIN_DIR.glob("run_*.txt"))
    out.append(f"runs completed: {len(dumps)} of {RUNS}")
    if not dumps:
        out.append("FAIL no run data (see harness.log)")
        return out
    loaded = [load_dump(p) for p in dumps]
    seeds = [h["seed"][0] for h, _ in loaded]
    spawns = [tuple(h["player"]) for h, _ in loaded]
    same_map = all(same_world(loaded[0], other) for other in loaded[1:])
    out.append(f"game seeds: {seeds}")
    out.append(f"player spawns: {spawns}")
    # The spawn may differ (a character saved elsewhere is first brought to the town), so the maps
    # are compared where both logs overlap in world coordinates.
    verdict = "PASS" if same_map else "FAIL"
    if len(set(seeds)) == 1 and len(loaded) > 1:
        verdict += " (all runs had the same game seed, so this only shows determinism)"
    else:
        verdict += f" ({len(set(seeds))} different game seeds)"
    out.append(f"{verdict} fixed seed: identical map in all runs = {same_map}")

    for i, (head, dump) in enumerate(loaded):
        head["run_index"] = i
        out.append(f"--- run {i} (seed {head['seed'][0]})")
        out += check_collision(head, dump)
    return out


MIN_AGREEMENT = 0.98  # the right preset matches ~99.7%; a wrong variant of the same town ~94%


_expected_cache = {}


def preset_grid(rel, original=True):
    """Expected collision of a DS1 as a +1 (blocked) / -1 (free) grid."""
    key = (rel, original)
    if key not in _expected_cache:
        d = DS1(read_asset(rel, original=original))
        exp = collision.compute(d, collision.tile_table(read_asset, d))
        _expected_cache[key] = np.where(exp & 1, 1, -1).astype(np.int8)
    return _expected_cache[key]


def match(dump, expected):
    """Best placement of expected in dump: (dx, dy, agreement on known cells, known cell count)."""
    dy, dx, _ = correlate(dump, expected)
    ys, xs = np.mgrid[0:expected.shape[0], 0:expected.shape[1]]
    yy, xx = ys + dy, xs + dx
    inside = (yy >= 0) & (yy < dump.shape[0]) & (xx >= 0) & (xx < dump.shape[1])
    known = np.zeros_like(inside)
    known[inside] = dump[yy[inside], xx[inside]] != 0
    agree = float((dump[yy[known], xx[known]] == expected[known]).mean()) if known.any() else 0.0
    return dx, dy, agree, int(known.sum())


def locate_presets(head, dump, folders, min_agree=0.97):
    """Map pieces (DS1 presets) of the given tile folders that lie in a logged area.

    Pieces with little collision would match any open field, so a piece needs at least 40 blocked
    subtiles, and at least 80 % of it must be inside the logged area."""
    ox, oy = head["origin"]
    found = []
    for name in sorted(_names()):
        if not name.endswith(".ds1") or not any(name.startswith(f"data/global/tiles/{f}/") for f in folders):
            continue
        try:
            expected = preset_grid(name)
        except Exception:  # noqa: BLE001 - unreadable or unsupported piece
            continue
        if (expected == 1).sum() < 40 or expected.shape[0] > dump.shape[0] or expected.shape[1] > dump.shape[1]:
            continue
        dx, dy, agree, overlap = match(dump, expected)
        if (PROJECT / name).exists():  # an edited piece may match its edited form better
            alt = match(dump, preset_grid(name, original=False))
            if alt[2] > agree:
                dx, dy, agree, overlap = alt
        # outdoor pieces sit on the room grid (8 tiles = 40 subtiles); elsewhere it is a look-alike
        if '/outdoors/' in name and ((ox + dx) % 40 or (oy + dy) % 40):
            continue
        if agree >= min_agree and overlap >= 0.8 * expected.size:
            found.append((name, ox + dx, oy + dy, agree))
    return found


LOCATED = []  # (rel, world origin x, y, expected grid, edited tile list) from run 0


def check_collision(head, dump):
    out = []
    ox, oy = head["origin"]
    candidates = []
    for ds1_path in sorted(PROJECT.rglob("*.ds1")):
        rel = ds1_path.relative_to(PROJECT).as_posix()
        if is_outdoor_piece(rel):
            continue  # pieces of random outdoor levels: checked by random_area_phase
        if rel not in _names():
            continue  # a new map piece: no original to compare with
        d = DS1(ds1_path.read_bytes())
        orig = DS1(read_asset(rel, original=True))
        table = collision.tile_table(read_asset, d)
        exp = collision.compute(d, table)
        expected = np.where(exp & 1, 1, -1).astype(np.int8)
        dy, dx, score = correlate(dump, expected)
        # agreement on the overlapping known cells
        ys, xs = np.mgrid[0:expected.shape[0], 0:expected.shape[1]]
        yy, xx = ys + dy, xs + dx
        inside = (yy >= 0) & (yy < dump.shape[0]) & (xx >= 0) & (xx < dump.shape[1])
        known = np.zeros_like(inside)
        known[inside] = dump[yy[inside], xx[inside]] != 0
        agree = (dump[yy[known], xx[known]] == expected[known]).mean() if known.any() else 0.0
        candidates.append((rel, d, orig, exp, dx, dy, agree, int(known.sum())))
    # Variants of one map (e.g. the four act 1 towns) share most tiles; only the best match per
    # folder can be the map the character is in.
    best = {}
    for c in candidates:
        folder = c[0].rsplit("/", 1)[0]
        if folder not in best or c[6] > best[folder][6]:
            best[folder] = c
    for rel, d, orig, exp, dx, dy, agree, overlap in candidates:
        if best[rel.rsplit("/", 1)[0]][0] != rel or overlap < 500 or agree < MIN_AGREEMENT:
            out.append(f"skip {rel}: not the map the character was in (agreement {agree:.1%})")
            continue
        out.append(f"{rel}: located at world subtile ({ox + dx}, {oy + dy}), agreement {agree:.1%} over {overlap} cells")
        changed = sorted({n for key, cells in d.layers.items() for n, v in enumerate(cells)
                          if v != (orig.layers.get(key) or [0] * len(cells))[n]})
        if not any(l[0] == rel for l in LOCATED):
            LOCATED.append((rel, ox + dx, oy + dy, exp, [(n % d.width, n // d.width) for n in changed], head, dump))
        ok = bad = unseen = 0
        for n in changed:
            tx, ty = n % d.width, n // d.width
            want = exp[ty * 5:ty * 5 + 5, tx * 5:tx * 5 + 5] & 1
            got = []
            for sy in range(5):
                for sx in range(5):
                    y, x = ty * 5 + sy + dy, tx * 5 + sx + dx
                    got.append(dump[y, x] if 0 <= y < dump.shape[0] and 0 <= x < dump.shape[1] else 0)
            got = np.array(got).reshape(5, 5)
            if (got == 0).all():
                unseen += 1
            elif ((got == 1) == (want == 1))[got != 0].all():
                ok += 1
            else:
                bad += 1
                out.append(f"   tile ({tx},{ty}) differs: editor\n{want}\n   game\n{got}")
        out.append(f"{'PASS' if bad == 0 and ok else 'FAIL'} collision edits in {rel}: {ok} as expected, {bad} wrong, {unseen} outside the logged area")
        out += check_objects(rel, d, orig, ox + dx, oy + dy, head)
    return out


def check_objects(rel, d, orig, wx, wy, head):
    """Every DS1 object that differs from the original (moved or added NPC/object) must exist in
    the game near its new position: a server unit of the same type (1 monster/NPC, 2 object).
    NPCs may already walk along their path, so any path node also counts."""
    from ds1 import Ds1Objects
    out = []
    units_file = head.get("units_file") or (PLUGIN_DIR / f"units_{head['run_index']}.txt" if "run_index" in head else None)
    if not units_file or not units_file.exists():
        return out + ["skip objects: no unit list logged"]
    units = [tuple(map(int, l.split())) for l in units_file.read_text().splitlines() if l.strip()]
    now, before = Ds1Objects(d), Ds1Objects(orig)
    if not now.editable:
        return out
    old = {(o["type"], o["id"], o["x"], o["y"]) for o in before.objects}
    changed = [o for o in now.objects if (o["type"], o["id"], o["x"], o["y"]) not in old]
    paths = {(p["x"], p["y"]): p["nodes"] for p in now.paths}
    ok = bad = 0
    for o in changed:
        spots = [(o["x"], o["y"])] + [(n[0], n[1]) for n in paths.get((o["x"], o["y"]), [])] if o["type"] == 1 else [(o["x"], o["y"])]
        tol = 3 if o["type"] == 1 else 2
        found = None
        for t, cls, ux, uy in units:
            if t != o["type"]:
                continue
            if any(abs(ux - (wx + sx)) <= tol and abs(uy - (wy + sy)) <= tol for sx, sy in spots):
                found = (cls, ux, uy)
                break
        kind = "NPC" if o["type"] == 1 else "object"
        if found:
            ok += 1
            out.append(f"PASS {kind} id {o['id']} expected at ({wx + o['x']},{wy + o['y']}): unit class {found[0]} at ({found[1]},{found[2]})")
        else:
            bad += 1
            out.append(f"FAIL {kind} id {o['id']} expected at ({wx + o['x']},{wy + o['y']}): no unit there")
    if changed:
        out.append(f"{'PASS' if bad == 0 else 'FAIL'} game objects in {rel}: {ok} of {len(changed)} changed objects found in the game")
    return out


def is_outdoor_piece(rel):
    parts = rel.split("/")
    return len(parts) > 4 and parts[3].startswith("act") and parts[4] == "outdoors"


def random_area_phase():
    """Edited pieces that the town runs did not find live in random outdoor levels: read the layout
    of the act's outdoor levels from the game, teleport through them and check every placement."""
    located = {l[0] for l in LOCATED}
    acts = set()
    for p in PROJECT.rglob("*.ds1"):
        rel = p.relative_to(PROJECT).as_posix()
        if rel not in located and is_outdoor_piece(rel):
            acts.add(int(rel.split("/")[3][3:]) - 1)
    if not acts:
        return []
    rows = read_asset("data/global/excel/levels.txt", original=True).decode("latin1").splitlines()
    head = rows[0].split("\t")
    ia, it_, ii = head.index("Act"), head.index("DrlgType"), head.index("Id")
    ids = [int(r.split("\t")[ii]) for r in rows[1:]
           if len(r.split("\t")) > it_ and r.split("\t")[ia].isdigit() and int(r.split("\t")[ia]) in acts
           and r.split("\t")[it_] == "3" and r.split("\t")[ii].isdigit()]
    import explore  # noqa: PLC0415 - uses this module
    wanted = [p.relative_to(PROJECT).as_posix() for p in PROJECT.rglob("*.ds1")
              if is_outdoor_piece(p.relative_to(PROJECT).as_posix())]
    pd, start, ids = explore.map_levels(MOD, ids, wanted)
    explore.report(MOD, pd, start, "map")
    text = (casc.DATA / "assets" / "explore_report.txt").read_text(encoding="utf-8").splitlines()
    return ["", f"--- random outdoor levels {ids} (teleporting through them)"] + [
        l for l in text if l.startswith(("PASS", "FAIL", "   PASS", "   FAIL", "   INFO", "map with"))]


def movement_phase():
    """Run into every blocked edited tile and to one free control spot; the server position must
    never end on a blocked subtile and the control spot must be reached."""
    out = ["", "movement test"]
    if not LOCATED:
        return out + ["skip: no edited map located"]
    rel, wx, wy, exp, tiles, head, dump = LOCATED[0]
    targets, kinds = [], []
    for tx, ty in tiles:
        if (exp[ty * 5:ty * 5 + 5, tx * 5:tx * 5 + 5] & 1).all():
            targets.append((wx + tx * 5 + 2, wy + ty * 5 + 2))
            kinds.append(("blocked", tx, ty))
    # control: nearest free 7x7 area 10-30 subtiles from where the last run ends (one run command
    # paths only so far, and the spawn may be elsewhere)
    px, py = targets[-1] if targets else head["player"]
    ox, oy = head["origin"]
    best = None
    for r in range(10, 30):
        for ang in range(0, 360, 15):
            import math
            cx = int(px + r * math.cos(math.radians(ang)))
            cy = int(py + r * math.sin(math.radians(ang)))
            win = dump[cy - oy - 3:cy - oy + 4, cx - ox - 3:cx - ox + 4]
            if win.shape == (7, 7) and (win == -1).all():
                best = (cx, cy)
                break
        if best:
            break
    if best:
        targets.append(best)
        kinds.append(("free",))
    secs = run_game(runs=1, moves=targets)
    out.append(f"{len(targets)} move(s) in {secs:.0f} s")
    log = (PLUGIN_DIR / "harness.log").read_text() if (PLUGIN_DIR / "harness.log").exists() else ""
    import re
    ends = re.findall(r"move (\d+) from \((-?\d+),(-?\d+)\) target \((-?\d+),(-?\d+)\) ended \((-?\d+),(-?\d+)\) flags 0x([0-9A-F]+)", log)
    if len(ends) != len(targets):
        return out + [f"FAIL only {len(ends)} of {len(targets)} moves logged"]
    passed = 0
    for (i, sx, sy, tx, ty, ex, ey, fl), kind in zip(ends, kinds):
        sx, sy, tx, ty, ex, ey = map(int, (sx, sy, tx, ty, ex, ey))
        fl = int(fl, 16)
        moved = abs(ex - sx) + abs(ey - sy)
        if kind[0] == "blocked":
            tile_x0, tile_y0 = wx + kind[1] * 5, wy + kind[2] * 5
            inside = tile_x0 <= ex < tile_x0 + 5 and tile_y0 <= ey < tile_y0 + 5
            ok = not inside and not (fl & 1) and moved > 0
            out.append(f"{'PASS' if ok else 'FAIL'} run into blocked tile {kind[1:]}: from ({sx},{sy}) to target ({tx},{ty}), "
                       f"stopped at ({ex},{ey}), {'inside the tile!' if inside else 'outside the tile'}, moved {moved}")
        else:
            dist = max(abs(ex - tx), abs(ey - ty))
            ok = dist <= 2
            out.append(f"{'PASS' if ok else 'FAIL'} control move to free spot ({tx},{ty}): ended ({ex},{ey}), distance {dist}")
        passed += ok
    out.append(f"{'PASS' if passed == len(targets) else 'FAIL'} movement: {passed} of {len(targets)}")
    return out


if __name__ == "__main__":
    if not HARNESS.exists():
        sys.exit("build plugin/d2r-test-harness.dll first (plugin/build_harness.cmd)")
    if not PLUGIN_DIR.parent.parent.exists():
        sys.exit(f"mod {MOD} not found; export it from the editor first")
    secs = run_game()
    report = [f"in-game test of mod {MOD}, {RUNS} run(s), {secs:.0f} s"] + evaluate()
    report += movement_phase()
    report += random_area_phase()
    log = PLUGIN_DIR / "harness.log"
    if log.exists():
        report += ["", "harness.log:"] + log.read_text().splitlines()[-40:]
    text = "\n".join(report)
    print(text)
    (casc.DATA / "assets" / "ingame_test_report.txt").write_text(text, encoding="utf-8")
