"""World waypoints: a second waypoint menu for the new areas of a mod (tools/new_zone.py).

The game's waypoint menu has five act tabs and 40 waypoint bits per character, so new areas
cannot all go there. The d2r-world plugin adds its own in-game window, "World Waypoints",
with buttons for the new areas (any number, eight per page). It uses blue-green copies of the
waypoint graphics, so it is easy to tell from the old menu.

This module writes what the export needs besides the plugin DLL:
  - the [waypoint] lines of d2r-world.ini (level, warp type, always open, name)
  - the recoloured sprites under data/hd/global/ui/panel/worldwaypoints/
  - a "World Waypoints" button in the game's own waypoint panel (layout override)
"""
import json
import re

import numpy as np

SPRITES = {  # game sprite -> copy in the mod (both under data/hd/global/ui/panel/)
    "waypoints/waypoints_base": "worldwaypoints/world_base",
    "waypoints/waypoints_button": "worldwaypoints/world_button",
    "waypoints/waypoints_button_disabled": "worldwaypoints/world_button_disabled",
    "waypoints/waypoints_overlay": "worldwaypoints/world_overlay",
    "waypoints/waypoints_tab": "worldwaypoints/world_tab",
    "modals/modalbutton": "worldwaypoints/world_modalbutton",
}
TINT = (0.55, 1.05, 1.15)  # the grey and gold of the waypoint panel become blue-green (teal)
STRENGTH = 0.85            # how much of the tint replaces the original colour
PANEL_LAYOUTS = ["data/global/ui/layouts/waypointspanelexpansionhd.json",
                 "data/global/ui/layouts/waypointspaneloriginalhd.json"]

# Shown in the game's waypoint panel, below the waypoint list on the left (the HUD shows a quest
# log hint further right); it opens the world menu.
OPEN_BUTTON = """
        {
            "type": "ButtonWidget", "name": "WorldWaypointsButton",
            "fields": {
                "rect": { "x": 152, "y": 1392 },
                "filename": "PANEL\\\\WorldWaypoints\\\\World_ModalButton",
                "hoveredFrame": 3,
                "pressedFrame": 1,
                "textString": "World Waypoints",
                "pointSize": "$MediumFontSize",
                "textColor": "$FontColorLightTeal",
                "onClickMessage": "PanelManager:OpenPanel:d2r-world/Open",
            }
        },
"""


def recolor_sprite(raw, tint=TINT, strength=STRENGTH):
    """Tint an uncompressed SpA1 sprite (40-byte header, then RGBA rows): every pixel keeps its
    brightness and takes the tint colour, so the grey frame of the panel turns teal as well."""
    if raw[:4] != b"SpA1":
        raise ValueError("not a sprite")
    width = int.from_bytes(raw[8:12], "little")
    height = int.from_bytes(raw[12:16], "little")
    n = width * height * 4
    px = np.frombuffer(raw, dtype=np.uint8, count=n, offset=40).reshape(-1, 4).astype(np.float32) / 255.0
    rgb = px[:, :3]
    lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    tinted = lum[:, None] * np.array(tint, dtype=np.float32)
    px[:, :3] = np.clip(rgb * (1.0 - strength) + tinted * strength, 0.0, 1.0)
    out = (px * 255.0 + 0.5).astype(np.uint8).tobytes()
    return raw[:40] + out + raw[40 + n:]


def add_open_button(layout_text):
    """The game's waypoint panel layout with the World Waypoints button as its last child."""
    if "WorldWaypointsButton" in layout_text:
        return layout_text
    end = layout_text.rstrip().rfind("]")  # end of the root's children list
    if end < 0:
        raise ValueError("no children list in the waypoint panel layout")
    return layout_text[:end] + OPEN_BUTTON + layout_text[end:]


def zone_name(zone):
    key = zone["level"].get("string_key", "")
    return zone.get("strings", {}).get(key, {}).get("enUS") or zone["level"].get("name") or f"Level {zone['level']['id']}"


def ini_lines(zones):
    """[waypoint] lines: level,warp type,always open,name. Towns are open from the start; other
    areas open the first time the character enters them."""
    lines = []
    for z in zones:
        lv = z["level"]
        name = re.sub(r"[\r\n,]", " ", zone_name(z)).strip()
        warp = 0 if lv.get("waypoint") is not None else 13  # 0 = at the level's waypoint, 13 = level start
        lines.append(f"waypoint={lv['id']},{warp},{1 if lv.get('town') else 0},{name}")
    return lines


def install(data_root, read_asset):
    """Write the recoloured sprites and the extended waypoint panel layouts into the mod."""
    base = data_root / "data/hd/global/ui/panel"
    for src, dst in SPRITES.items():
        for suffix in (".sprite", ".lowend.sprite"):
            try:
                raw = read_asset(f"data/hd/global/ui/panel/{src}{suffix}")
            except FileNotFoundError:
                continue
            out = base / (dst + suffix)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(recolor_sprite(raw))
    for path in PANEL_LAYOUTS:
        text = read_asset(path).decode("utf-8-sig")
        out = data_root / path
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(add_open_button(text), encoding="utf-8")


if __name__ == "__main__":
    print(json.dumps(OPEN_BUTTON))
