"""Walk the test character out of town and log the map on the way (no mouse, game on monitor 2, muted).

  python -I tools/explore.py <mod> [legs]          explore: plan every leg from the newest map log
  python -I tools/explore.py <mod> --replay        walk the route saved by the last exploration again
  python -I tools/explore.py <mod> --map 2,3       read the room layout of these levels from the game
                                                   (no walking) and teleport through them, logging
                                                   the map at enough spots to cover every room

Exploring: after each leg the harness logs the server map around the player (explore_<k>.txt) and
waits; this script plans the next leg over walkable subtiles towards the edge of the loaded area
that lies farthest from the start, writes it to moves.txt and lets the harness go on.
The route is saved to assets/explore/route.txt. With the fixed-seed plugin every game builds the
same areas, so --replay reaches the same spots and logs them again (used to check edits in random
areas). Both modes find the map presets (DS1 pieces of act1/outdoors) under each log by the same
cross-correlation as the in-game test and write assets/explore_report.txt.
"""
import collections
import json
import math
import pathlib
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import ingame_test as it  # noqa: E402

MAX_LEG = 90       # subtiles walked per leg at most
POINT_EVERY = 12   # one run command per this many subtiles of the route
OUT = it.casc.DATA / "assets" / "explore"
FOLDERS = ("act1/outdoors",)


def plan_leg(dump_path, start):
    """Route (world subtiles) from the player towards the farthest edge of the loaded area."""
    head, grid = it.load_dump(dump_path)
    ox, oy = head["origin"]
    h, w = grid.shape
    px, py = head["player"][0] - ox, head["player"][1] - oy
    walk = lambda x, y: 0 <= x < w and 0 <= y < h and grid[y, x] == -1  # noqa: E731
    prev = {(px, py): None}
    q = collections.deque([(px, py)])
    best, best_score = None, -1e9
    while q:
        x, y = q.popleft()
        frontier = x in (0, w - 1) or y in (0, h - 1) or any(
            0 <= x + dx < w and 0 <= y + dy < h and grid[y + dy, x + dx] == 0
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
        if frontier:
            score = math.hypot(x + ox - start[0], y + oy - start[1])
            if score > best_score:
                best, best_score = (x, y), score
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            n = (x + dx, y + dy)
            if n not in prev and walk(*n) and (dx == 0 or dy == 0 or (walk(x + dx, y) and walk(x, y + dy))):
                prev[n] = (x, y)
                q.append(n)
    if not best:
        return []
    path = []
    c = best
    while c:
        path.append(c)
        c = prev[c]
    path.reverse()
    path = path[:MAX_LEG + 1]
    if len(path) < 4:
        return []
    points = path[POINT_EVERY::POINT_EVERY]
    if not points or points[-1] != path[-1]:
        points.append(path[-1])
    return [(int(x + ox), int(y + oy)) for x, y in points]


def start_game(mod, pd, extra="", wait=False):
    for f in list(pd.glob("run_*.txt")) + list(pd.glob("units_*.txt")) + list(pd.glob("explore*.txt")) + [
            pd / "done.txt", pd / "harness.log", pd / "moves.txt", pd / "moves.wait"]:
        f.unlink(missing_ok=True)
    shutil.copy2(it.HARNESS, pd / it.HARNESS.name)
    (pd / "test-harness.ini").write_text(
        "runs=1\nradius=120\nsettle_ticks=100\nwindow_x=-3840\nwindow_y=0\nwindow_w=1600\nwindow_h=900\nvary_game_seed=0\n" + extra)
    if wait:  # the harness waits for this file to go before it moves
        (pd / "moves.wait").write_text("the route is being planned\n")
    return subprocess.Popen([str(it.GAME / "D2RLoader.exe"), "-mod", mod], cwd=str(it.GAME))


def finish(proc, pd, start):
    while proc.poll() is None and time.time() - start < it.TIMEOUT:
        if (pd / "done.txt").exists():
            break
        time.sleep(2)
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
    (pd / "moves.wait").unlink(missing_ok=True)
    for _ in range(60):  # the game may hold the DLL for a moment after it exits
        try:
            (pd / it.HARNESS.name).unlink(missing_ok=True)
            break
        except PermissionError:
            time.sleep(2)


def explore(mod, legs):
    pd = it.GAME / "mods" / mod / "d2rloader" / "plugins"
    start = time.time()
    proc = start_game(mod, pd)
    (pd / "moves.txt").write_text("plan\n")
    route = []
    try:
        spawn = None
        for k in range(legs + 1):
            dump = pd / f"explore_{k}.txt"
            while not ((pd / "moves.wait").exists() and dump.exists()):
                if proc.poll() is not None or time.time() - start > it.TIMEOUT:
                    raise SystemExit(f"the game stopped before map log {k}")
                time.sleep(0.5)
            time.sleep(0.3)
            head, _ = it.load_dump(dump)
            spawn = spawn or tuple(head["player"])
            leg = plan_leg(dump, spawn) if k < legs else []
            route += [f"{x} {y}" for x, y in leg] + ["dump"]
            print(f"leg {k}: player {head['player']}, {len(leg)} points" + (f" to {leg[-1]}" if leg else ""), flush=True)
            (pd / "moves.txt").write_text("\n".join([f"{x} {y}" for x, y in leg] + ["plan" if leg else "dump"]) + "\n")
            (pd / "moves.wait").unlink()
            if not leg:
                break
    finally:
        finish(proc, pd, start)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "route.txt").write_text("\n".join(route) + "\n")
    return pd, start


def replay(mod):
    pd = it.GAME / "mods" / mod / "d2rloader" / "plugins"
    route = (OUT / "route.txt").read_text().splitlines()
    start = time.time()
    proc = start_game(mod, pd)
    (pd / "moves.txt").write_text("\n".join(route) + "\n")
    finish(proc, pd, start)
    return pd, start


COVER = 85  # a map log (radius 120) covers every room centre within this many subtiles


def read_levels(path):
    """levels_<n>.txt from the harness: {level id: [(tile x, y, w, h), ...]}"""
    levels, cur = {}, None
    for line in path.read_text().splitlines():
        t = line.split()
        if t[0] == "L":
            cur = levels.setdefault(int(t[1]), [])
        elif t[0] == "R" and cur is not None:
            cur.append(tuple(map(int, t[1:5])))
    return levels


def cover_points(rooms, start):
    """Spots to log from (world subtiles) so every room centre is near one, in a short visiting order."""
    centres = [((x + w / 2) * 5, (y + h / 2) * 5) for x, y, w, h in rooms]
    left = list(range(len(centres)))
    spots = []
    while left:
        # the room centre that covers the most uncovered centres
        best = max(left, key=lambda i: sum(math.dist(centres[i], centres[j]) <= COVER for j in left))
        spots.append(centres[best])
        left = [j for j in left if math.dist(centres[best], centres[j]) > COVER]
    order, pos = [], start
    while spots:
        nxt = min(spots, key=lambda p: math.dist(p, pos))
        spots.remove(nxt)
        order.append((int(nxt[0]), int(nxt[1])))
        pos = nxt
    return order


def map_levels(mod, level_ids, wanted=None):
    """Teleport through the levels one by one, logging the map. With wanted (DS1 paths of edited
    pieces) it stops after the level in which the last of them was found, so a piece near the
    town needs only the first level instead of the whole act."""
    pd = it.GAME / "mods" / mod / "d2rloader" / "plugins"
    start = time.time()
    proc = start_game(mod, pd, "levels=" + ",".join(map(str, level_ids)) + "\n", wait=True)
    visited = []
    try:
        while not ((pd / "run_0.txt").exists() and (pd / "levels_0.txt").exists()):
            if proc.poll() is not None or time.time() - start > 300:
                raise SystemExit("the game did not log the level layout")
            time.sleep(0.5)
        time.sleep(0.5)
        head, _ = it.load_dump(pd / "run_0.txt")
        levels = read_levels(pd / "levels_0.txt")
        pos, logs, missing = tuple(head["player"]), 0, set(wanted or [])
        for n, lid in enumerate(level_ids):
            spots = cover_points(levels.get(lid, []), pos)
            if not spots:
                continue
            last = n == len(level_ids) - 1
            lines = []
            for x, y in spots:
                lines += [f"t {x} {y}", "dump"]
            lines[-1] = "dump" if last or not wanted else "plan"
            (pd / "moves.txt").write_text("\n".join(lines) + "\n")
            (pd / "moves.wait").unlink(missing_ok=True)
            visited.append(lid)
            print(f"level {lid}: {len(levels.get(lid, []))} rooms, {len(spots)} map logs", flush=True)
            pos = spots[-1]
            logs += len(spots)
            if last or not wanted:
                break
            # wait for this level's logs and the harness asking for more
            while not ((pd / "moves.wait").exists() and (pd / f"explore_{logs - 1}.txt").exists()):
                if proc.poll() is not None or time.time() - start > it.TIMEOUT:
                    raise SystemExit("the game stopped while mapping")
                time.sleep(0.3)
            time.sleep(0.3)
            for k in range(logs - len(spots), logs):
                h, dump = it.load_dump(pd / f"explore_{k}.txt")
                missing -= {rel for rel, *_ in it.locate_presets(h, dump, FOLDERS)}
            if not missing:
                print(f"all edited pieces found after level {lid}", flush=True)
                (pd / "moves.txt").write_text("dump\n")
                (pd / "moves.wait").unlink(missing_ok=True)
                break
    finally:
        finish(proc, pd, start)
    OUT.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pd / "levels_0.txt", OUT / "levels.txt")
    return pd, start, visited


def check_placement(rel, wx, wy, head, dump):
    """Edited tiles of one placement of a piece. Tiles on the piece's border may be covered by the
    neighbouring piece (random levels overlap pieces by one tile), so those only count as info."""
    from ds1 import DS1
    d = DS1(it.read_asset(rel))
    orig = DS1(it.read_asset(rel, original=True))
    exp = it.preset_grid(rel, original=False)
    ox, oy = head["origin"]
    ok = bad = covered = unseen = 0
    changed = sorted({n for key, cells in d.layers.items() for n, v in enumerate(cells)
                      if v != (orig.layers.get(key) or [0] * len(cells))[n]})
    for n in changed:
        tx, ty = n % d.width, n // d.width
        want = exp[ty * 5:ty * 5 + 5, tx * 5:tx * 5 + 5]
        y0, x0 = wy - oy + ty * 5, wx - ox + tx * 5
        if y0 < 0 or x0 < 0 or y0 + 5 > dump.shape[0] or x0 + 5 > dump.shape[1]:
            unseen += 1
            continue
        got = dump[y0:y0 + 5, x0:x0 + 5]
        if (got == 0).all():
            unseen += 1
        elif (got[got != 0] == want[got != 0]).all():
            ok += 1
        elif tx in (0, d.width - 1) or ty in (0, d.height - 1):
            covered += 1
        else:
            bad += 1
    verdict = "PASS" if bad == 0 and ok else "FAIL" if bad else "INFO"
    return (f"{verdict} {rel.split('/')[-1]} at {wx},{wy}: {ok} edited tiles active, {bad} not, "
            f"{covered} on the border covered by a neighbour piece, {unseen} outside the log")


def report(mod, pd, start, title):
    OUT.mkdir(parents=True, exist_ok=True)
    out = [f"{title} with mod {mod}: {time.time() - start:.0f} s"]
    found, placed = {}, {}
    logs = sorted(pd.glob("explore_[0-9]*.txt"), key=lambda p: int(p.stem.split("_")[1]))
    for p in logs:
        k = int(p.stem.split("_")[1])
        shutil.copy2(p, OUT / f"{title}_{k}.txt")
        head, dump = it.load_dump(p)
        matches = it.locate_presets(head, dump, FOLDERS)
        out.append(f"log {k}: player {head['player']}: "
                   + (", ".join(f"{rel.split('/')[-1]} at {wx},{wy} ({a:.1%})" for rel, wx, wy, a in matches) or "no preset found"))
        for rel, wx, wy, a in matches:
            found.setdefault(rel, {"x": int(wx), "y": int(wy), "agree": float(a), "log": k})
        if title in ("replay", "map"):  # edited pieces: every placement found in this log
            for rel, wx, wy, a in matches:
                if (it.PROJECT / rel).exists():
                    line = check_placement(rel, wx, wy, head, dump)
                    out.append(f"   {line}")
                    key = (rel, int(wx), int(wy))  # a placement seen in several logs counts once, best view
                    if key not in placed or placed[key].startswith("INFO") or line.startswith("PASS"):
                        placed[key] = line
    if placed:
        results = list(placed.values())
        bad = [r for r in results if r.startswith("FAIL")]
        out.insert(1, f"{'PASS' if not bad else 'FAIL'} edited pieces in random areas: {len(results) - len(bad)} of {len(results)} placements as edited")
    log = pd / "harness.log"
    if log.exists():
        out += ["", "harness.log:"] + log.read_text().splitlines()[-25:]
    text = "\n".join(out)
    print(text)
    (it.casc.DATA / "assets" / "explore_report.txt").write_text(text, encoding="utf-8")
    return found


def main():
    mod = sys.argv[1] if len(sys.argv) > 1 else "D2REditorTest"
    if "--map" in sys.argv:
        ids = [int(v) for v in sys.argv[sys.argv.index("--map") + 1].split(",")]
        pd, start, _ = map_levels(mod, ids)
        found = report(mod, pd, start, "map")
        (OUT / "found.json").write_text(json.dumps(found, indent=1))
        return
    if "--replay" in sys.argv:
        pd, start = replay(mod)
        report(mod, pd, start, "replay")
        return
    legs = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    pd, start = explore(mod, legs)
    found = report(mod, pd, start, "explore")
    (OUT / "found.json").write_text(json.dumps(found, indent=1))


if __name__ == "__main__":
    main()
