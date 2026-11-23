"""In-game test of the NPCs from the NPC creator, without screenshots.

  python -I tools/npc_ingame_test.py <ModName>

The mod must be exported with the NPCs placed in the act 1 town. The script starts the game on
the second monitor (test harness), asks the d2r-npc plugin for the positions of the new NPCs,
teleports next to them and clicks them with the plugin's fake mouse (the real mouse is not
used). Every check reads the plugin log (d2r-npc.log): the NPC menu opens, the NPC's own speech
replaces the game's text, and a trader opens the trade window. Result: PASS/FAIL lines and
assets/npc_test_report.txt.
"""
import ctypes
import ctypes.wintypes as wt
import pathlib
import re
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

MOD = sys.argv[1] if len(sys.argv) > 1 else "D2REditorTest"
sys.argv = [sys.argv[0], MOD]
import explore  # noqa: E402
import ingame_test as it  # noqa: E402

u32 = ctypes.windll.user32
PD = it.PLUGIN_DIR
LOG = PD / "d2r-npc.log"
CURSOR = PD / "d2r-npc-cursor.txt"
# screen position of a subtile relative to the player (window 1600x900 on monitor 2, default zoom):
# x = 800 + 22.86 * (dx - dy), feet y = 450 + 10 * (dx + dy); measured on the act 1 town
SCREEN_X, SCREEN_Y, PER_X, PER_Y, BODY = 800, 450, 22.86, 10.0, 50
results = []


def log_text():
    return LOG.read_text(errors="replace") if LOG.exists() else ""


def wait_log(pattern, since, limit=8.0):
    t0 = time.time()
    while time.time() - t0 < limit:
        if re.search(pattern, log_text()[since:]):
            return True
        time.sleep(0.3)
    return False


def check(name, ok, detail=""):
    results.append(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    print(results[-1], flush=True)
    return ok


def window():
    found = []

    def cb(h, _):
        buf = ctypes.create_unicode_buffer(256)
        u32.GetWindowTextW(h, buf, 256)
        if buf.value.startswith("Diablo II") and u32.IsWindowVisible(h):
            found.append(h)
        return True
    u32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)(cb), 0)
    return found[0] if found else None


def client_origin(h):
    pt = wt.POINT(0, 0)
    u32.ClientToScreen(h, ctypes.byref(pt))
    return pt.x, pt.y


def click(x, y):
    """Click at window position (x, y) of the 1600x900 game window grab (monitor 2 at -3840,0)."""
    h = window()
    ox, oy = client_origin(h)
    sx, sy = x - 3840, y
    lp = ((sy - oy) << 16) | ((sx - ox) & 0xFFFF)
    CURSOR.write_text(f"{sx} {sy}")
    time.sleep(0.3)
    u32.SendMessageW(h, 0x0006, 1, 0)
    for msg, wp in ((0x0200, 0), (0x0200, 0), (0x0201, 1), (0x0202, 0)):
        if msg == 0x0201:
            CURSOR.write_text(f"{sx} {sy} 1")
        if msg == 0x0202:
            CURSOR.write_text(f"{sx} {sy} 0")
        time.sleep(0.1)
        u32.SendMessageW(h, msg, wp, lp)
        time.sleep(0.25)
    CURSOR.unlink(missing_ok=True)


def key(vk):
    h = window()
    u32.SendMessageW(h, 0x0100, vk, 0)
    time.sleep(0.05)
    u32.SendMessageW(h, 0x0101, vk, 0)
    time.sleep(0.3)


TRADERS = {154, 148, 147, 178, 177, 199, 202, 253, 254, 255, 252, 257, 405, 511, 512, 513}


def action(word):
    (PD / "d2r-npc-action.txt").write_text(word)
    time.sleep(1.5)


def close_all():
    """Escape closes the open window; a second one would open the game menu, so only if needed."""
    mark = len(log_text())
    key(0x1B)
    time.sleep(0.5)
    if "OpenPanel PauseLayout" in log_text()[mark:]:
        key(0x1B)


def open_menu(cls):
    """Click the NPC (fresh positions each try, it may walk) until its menu opens."""
    for _ in range(3):
        player, units = positions()
        if cls not in units:
            return False
        x, y = screen_of(player, units[cls])
        mark = len(log_text())
        click(round(x), round(y - BODY))
        if wait_log(r"OpenPanel NpcDialogPanel", mark, 6):
            return True
        close_all()
    return False


def positions():
    """Player and monster positions from the plugin's dump."""
    start = len(log_text())
    (PD / "d2r-npc-dump.txt").write_text("")
    if not wait_log(r"dump: player at", start, 5):
        return None, {}
    time.sleep(0.5)
    text = log_text()[start:]
    p = re.search(r"dump: player at (\d+),(\d+)", text)
    units = {int(c): (int(x), int(y)) for c, x, y in re.findall(r"class (\d+) at (\d+),(\d+)", text)}
    return (int(p.group(1)), int(p.group(2))), units


def screen_of(player, pos):
    dx, dy = pos[0] - player[0], pos[1] - player[1]
    return SCREEN_X + PER_X * (dx - dy), SCREEN_Y + PER_Y * (dx + dy)


def main():
    ini = (PD / "d2r-npc.ini").read_text()
    npcs = {int(a): int(b) for a, b in re.findall(r"npc=(\d+),(\d+)", ini)}
    speech = {int(a) for a in re.findall(r"speech=(\d+),", ini)}
    if "test_cursor=1" not in ini:
        (PD / "d2r-npc.ini").write_text(ini.rstrip() + "\ntest_cursor=1\n")
    LOG.unlink(missing_ok=True)
    t0 = time.time()
    proc = explore.start_game(MOD, PD, wait=True, start_level=1)
    try:
        while "run 0 dumped" not in ((PD / "harness.log").read_text(errors="replace") if (PD / "harness.log").exists() else ""):
            time.sleep(1)
            if time.time() - t0 > 180:
                return check("game reached the town", False)
        check("game reached the town", True)
        player, units = positions()
        found = {c: units[c] for c in npcs if c in units}
        check("NPCs placed in the town", len(found) == len(npcs), f"{len(found)} of {len(npcs)} found")
        if not found:
            return
        first = next(iter(found.values()))
        (PD / "moves.txt").write_text(f"t {first[0] - 2} {first[1] + 5}\nw 600000\n")
        (PD / "moves.wait").unlink(missing_ok=True)
        time.sleep(8)
        for cls, base in npcs.items():
            if cls not in found:
                continue
            if not check(f"class {cls}: NPC menu opens on click", open_menu(cls)):
                continue
            if base in TRADERS:
                mark = len(log_text())
                action("trade")
                check(f"class {cls}: trade window opens", wait_log(r"OpenPanel Vendor", mark, 6))
                close_all()
                if not open_menu(cls):
                    check(f"class {cls}: NPC menu opens again", False)
                    continue
            if cls in speech:
                mark = len(log_text())
                action("talk")
                action("gossip")
                check(f"class {cls}: own speech in the game's speech window",
                      wait_log(rf"speech: NPC class {cls} says string", mark, 6))
            close_all()
    finally:
        proc.kill()
        for _ in range(30):  # the test parts leave the mod again
            try:
                (PD / it.HARNESS.name).unlink(missing_ok=True)
                break
            except PermissionError:
                time.sleep(1)
        (PD / "moves.wait").unlink(missing_ok=True)
        CURSOR.unlink(missing_ok=True)
        ini_path = PD / "d2r-npc.ini"  # the mod goes back to normal play (no test mouse)
        ini_path.write_text("".join(x for x in ini_path.read_text().splitlines(True) if not x.startswith("test_")))
        report = it.casc.DATA / "assets" / "npc_test_report.txt"
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text("\n".join(results) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
