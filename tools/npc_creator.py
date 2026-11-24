"""NPC creator: new NPCs for a mod, made from the editor's NPC list (editor_state/npcs.json).

Every NPC is a new row at the end of monstats.txt (its class id is the row number). It has the
look of a chosen game NPC (its MonStatsEx and model code) and a role:
  - talk:  it only talks
  - trade: it trades with the goods and prices of a chosen town NPC (a copy of its npc.txt row)
Both say their own text ("Talk" in the NPC menu) in the game's own speech window: the text is a
new string in npcs.json and the plugin hands its id to the game's speech function.
What an NPC does is fixed in the game code per class; the d2r-npc plugin (plugin/npc.cpp) gives
a new NPC the behaviour of the chosen town NPC. The export writes its config, d2r-npc.ini.

New NPCs are placed like other monsters: monpreset.txt gets a row per act, so the editor's
"Add game object" list offers them.
"""
import json
import re

TALK_BASE = "cain1"  # an act 1 town NPC record without trade or other services
LANGS = ("enUS", "zhTW", "deDE", "esES", "frFR", "itIT", "koKR", "plPL", "esMX", "jaJP", "ptBR", "ruRU", "zhCN")
# town NPCs that trade, by monstats Id -> shown name
TRADERS = {"charsi": "Charsi (smith)", "akara": "Akara (potions, magic)", "gheed": "Gheed (gambling)",
           "fara": "Fara (smith)", "drognan": "Drognan (magic)", "elzix": "Elzix (weapons)",
           "lysander": "Lysander (potions)", "hratli": "Hratli (smith)", "alkor": "Alkor (potions)",
           "ormus": "Ormus (magic)", "asheara": "Asheara (weapons)", "halbu": "Halbu (smith)",
           "jamella": "Jamella (magic)", "larzuk": "Larzuk (smith)", "malah": "Malah (potions)",
           "drehya": "Anya (magic)"}


class Tables:
    """Reads tables (project copy first) and writes changed ones into the project."""

    def __init__(self, read_asset, project):
        self.read_asset, self.project, self.cache = read_asset, project, {}

    def rows(self, name, original=False):
        raw = self.read_asset(f"data/global/excel/{name}.txt", original=original).decode("latin1")
        nl = "\r\n" if "\r\n" in raw else "\n"
        rows = [r.split("\t") for r in raw.split(nl)]
        while rows and rows[-1] == [""]:
            rows.pop()
        return rows, nl

    def write(self, name, rows, nl):
        dst = self.project / f"data/global/excel/{name}.txt"
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes((nl.join("\t".join(r) for r in rows) + nl).encode("latin1"))


def safe_id(text):
    s = re.sub(r"[^a-z0-9]+", "", text.lower())[:20]
    return "npc" + (s or "x")


def looks(read_asset):
    """Game NPCs whose look can be used: monstats rows with npc=1 (Id -> name)."""
    t = Tables(read_asset, None)
    rows, _ = t.rows("monstats", original=True)
    col = {k: i for i, k in enumerate(rows[0])}
    out = {}
    for r in rows[1:]:
        if len(r) > col["npc"] and r[col["npc"]] == "1" and r[col["inTown"]] == "1":
            out[r[col["Id"]]] = r[col["NameStr"]]
    return out


BANKS = ("", "base/")  # the game keeps two table sets: current (data/global/excel/) and base/ (classic and LoD)
TABLES = ("monstats", "npc", "monpreset")


def build(npcs, read_asset, project, monsters=()):
    """Write the NPC and own monster rows into the project's tables (both banks).
    Returns (ini lines, {id: class id}). Monsters come after the NPCs, so NPC class ids stay."""
    t = Tables(read_asset, project)
    result = None
    for bank in BANKS:
        ini, classes, strings, speech, tables = build_bank(t, bank, npcs, monsters)
        if result and result[1] != classes:
            raise ValueError("the two table sets give the NPCs different class ids")
        result = result or (ini, classes, strings, speech)
        for name, (rows, nl) in tables.items():
            if npcs or monsters:
                t.write(bank + name, rows, nl)
            else:  # no NPCs: the project's tables go back to the originals
                (project / f"data/global/excel/{bank}{name}.txt").unlink(missing_ok=True)
    # HD look: the client finds data/hd/character/<group>/<monstats Id>.json, so every NPC gets a copy
    # of its look's file (the file names the look's model, skeleton and textures by full path)
    hd = project / "data/hd/character"
    ours = {n["id"] for n in npcs} | {m["id"] for m in monsters}
    for old in [*hd.glob("*/npc*.json"), *hd.glob("*/cm*.json")] if hd.exists() else []:
        if old.stem not in ours:
            old.unlink()
    for m in monsters:  # own monsters look like their game monster (enemy/ holds the monsters)
        for group in ("enemy", "npc", "monsters"):
            try:
                raw = read_asset(f"data/hd/character/{group}/{m['look']}.json", original=True)
            except FileNotFoundError:
                continue
            dst = hd / group / f"{m['id']}.json"
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(raw)
            break
    for n in npcs:
        for group in ("npc", "monsters"):
            try:
                raw = read_asset(f"data/hd/character/{group}/{n['look']}.json", original=True)
            except FileNotFoundError:
                continue
            dst = hd / group / f"{n['id']}.json"
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(raw)
            break
    # string ids: the game's speech function takes a 16-bit id, so the NPC strings get free ids
    # below 65536 (the same in both string folders)
    ini, classes, strings, speech = result
    ids = dict(zip(strings, free_string_ids(read_asset, len(strings)))) if strings else {}
    ini = ini + [f"speech={cls},{ids[key]}" if isinstance(cls, int) else f"speech_stage={cls[0]},{cls[1]},{ids[key]}"
                 for cls, key in speech.items()]
    for path in ("data/local/lng/strings/npcs.json", "data/local/lng/strings-legacy/npcs.json"):
        if npcs or monsters:
            add_strings(read_asset, project, path, strings, ids)
        else:
            (project / path).unlink(missing_ok=True)
    return ini, classes


def build_bank(t, bank, npcs, monsters=()):
    orig, nl = t.rows(bank + "monstats", original=True)
    col = {k: i for i, k in enumerate(orig[0])}
    by_id = {r[col["Id"]]: r for r in orig[1:] if len(r) > col["Id"]}
    rows = [list(r) for r in orig]
    npc_rows, npc_nl = t.rows(bank + "npc", original=True)
    ncol = {k: i for i, k in enumerate(npc_rows[0])}
    npc_by = {r[ncol["npc"]]: r for r in npc_rows[1:] if r}
    pre_rows, pre_nl = t.rows(bank + "monpreset", original=True)
    classes, ini, strings, speech = {}, [], {}, {}
    for n in npcs:
        look = by_id.get(n.get("look", ""))
        if not look:
            raise ValueError(f"{n['name']}: unknown look {n.get('look')}")
        base = n.get("trade_like") if n.get("role") == "trade" else TALK_BASE
        if base not in by_id:
            raise ValueError(f"{n['name']}: unknown town NPC {base}")
        cls = sum(1 for r in rows[1:] if r and r[0] != "Expansion")  # marker rows have no class
        row = list(look) + [""] * (len(orig[0]) - len(look))
        row[col["Id"]] = n["id"]
        row[col["*hcIdx"]] = str(cls)
        # BaseId stays the look's: the client finds the HD model and animations through it
        row[col["NextInClass"]] = ""
        row[col["NameStr"]] = n["id"]
        row[col["AI"]] = "Npc"  # some looks have other AIs (cain1: NpcOutOfTown hides it in town)
        rows.append(row)
        classes[n["id"]] = cls
        strings[n["id"]] = n["name"]
        ini.append(f"npc={cls},{by_id[base][col['*hcIdx']]}")
        if n.get("role") == "trade":
            src = npc_by.get(base)
            if src:
                new = list(src)
                new[ncol["npc"]] = n["id"]
                npc_rows.append(new)
        if n.get("text", "").strip():
            strings[n["id"] + "Speech"] = n["text"].strip()
            speech[cls] = n["id"] + "Speech"
        for st in n.get("stages", []):  # texts by quest stage (a quest plugin writes the stage)
            key = f"{n['id']}Stage{int(st['stage'])}"
            strings[key] = st["text"].strip()
            speech[(cls, int(st["stage"]))] = key
        for act in range(1, 6):  # placeable in every act
            # the game reads each act's rows as one block: insert after the act's last row
            last = max(k for k, r in enumerate(pre_rows) if r and r[0] == str(act))
            pre_rows.insert(last + 1, [str(act), n["id"]] + [""] * (len(pre_rows[0]) - 2))
    for m in monsters:  # own monsters: a game monster's row with own name, level, life and loot
        look, tc = by_id.get(m["look"]), by_id.get(m.get("tc") or m["look"])
        if not look or not tc:
            raise ValueError(f"{m['name']}: unknown monster {m['look']}")
        cls = sum(1 for r in rows[1:] if r and r[0] != "Expansion")
        row = list(look) + [""] * (len(orig[0]) - len(look))
        row[col["Id"]] = m["id"]
        row[col["*hcIdx"]] = str(cls)
        row[col["NextInClass"]] = ""
        row[col["NameStr"]] = m["id"]
        row[col["enabled"]] = "1"
        for k, v in zip(("Level", "Level(N)", "Level(H)"), m.get("level") or []):
            row[col[k]] = str(int(v))
        for k in ("minHP", "maxHP", "MinHP(N)", "MaxHP(N)", "MinHP(H)", "MaxHP(H)"):
            if k in col and str(row[col[k]]).strip().lstrip("-").isdigit():
                row[col[k]] = str(max(1, int(row[col[k]]) * int(m.get("hp", 100)) // 100))
        for k in col:
            if k.startswith("TreasureClass") and "Quest" not in k:
                row[col[k]] = tc[col[k]] if col[k] < len(tc) else ""
        rows.append(row)
        classes[m["id"]] = cls
        strings[m["id"]] = m["name"]
        for act in range(1, 6):
            last = max(k for k, r in enumerate(pre_rows) if r and r[0] == str(act))
            pre_rows.insert(last + 1, [str(act), m["id"]] + [""] * (len(pre_rows[0]) - 2))
    return ini, classes, strings, speech, {"monstats": (rows, nl), "npc": (npc_rows, npc_nl), "monpreset": (pre_rows, pre_nl)}


STRING_FILES = ("abilities", "bnet", "chinese-overlay", "commands", "item-gems", "item-modifiers", "item-nameaffixes",
                "item-names", "item-runes", "keyword-guide", "levels", "mercenaries", "monsters", "npcs", "objects",
                "quests", "shrines", "skills", "ui", "ui-controller", "vo", "keybinds", "presence-states")


def free_string_ids(read_asset, count, start=60000):
    used = set()
    for folder in ("strings", "strings-legacy"):
        for name in STRING_FILES:
            try:
                data = json.loads(read_asset(f"data/local/lng/{folder}/{name}.json", original=True).decode("utf-8-sig"))
            except (FileNotFoundError, ValueError):
                continue
            used.update(e.get("id", 0) for e in data if isinstance(e, dict))
    free = [i for i in range(start, 65535) if i not in used][:count]
    if len(free) < count:
        raise ValueError("no free string ids left")
    return free


def add_strings(read_asset, project, path, strings, ids):
    data = json.loads(read_asset(path, original=True).decode("utf-8-sig"))
    data = [e for e in data if e.get("Key") not in strings]
    for key, text in strings.items():
        data.append({"id": ids[key], "Key": key, **{lang: text for lang in LANGS}})
    dst = project / path
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8-sig")
