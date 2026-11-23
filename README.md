# D2R Level Editor

A 3D editor for the HD maps of **Diablo II: Resurrected**. Open a map, place, move, rotate and
scale objects, change where the player can walk, and export the result as a mod.

The editor reads models, textures and maps straight from your installed game (read-only).
This repository and the download contain no game data.

## Download and start

1. Download `D2R Level Editor (release).zip` from the
   [releases](https://github.com/notenoughsp/d2r-level-editor/releases) and unpack it.
2. Start `D2REditor.exe`. If the game is not found, it asks for the game folder once.
3. To play an exported mod you need [D2RLoader](https://d2rloader.net):
   `D2RLoader.exe -mod <ModName>`.

You need Windows, Diablo II: Resurrected, and Edge or Chrome (the editor opens in an app window).
The language (English or Deutsch) can be switched in the toolbar.

## What you can do

| | |
|---|---|
| **Maps** | Open any HD map (towns, outdoor pieces, dungeons). A banner tells whether the game uses the map once or as a shared piece in random areas. Recently opened maps come first; maps you edited are marked and can be filtered. |
| **Models** | Search all ~12,000 HD models with a preview, and place them with a double-click or **P**. Mark favourites with the star. **Scatter** places many copies at once (count, radius, size range, random rotation), e.g. plants and rocks. |
| **Edit** | Select, move, rotate, scale, duplicate, copy and paste (also into other maps), snap to a grid, drop to the ground, random rotation, copies in a row (fences, torches), align and space several objects, replace models with another model, select all objects with the same model, keep moved objects on the ground, hide objects while you work. Undo and redo. |
| **Game objects** | NPCs, monster spawns, chests, waypoints, torches: move, change, delete or add them. |
| **Collision** | See where the player can walk and paint tiles blocked or free. "Collision under object" blocks the tiles under a model and moves along with it. |
| **NPCs** | Make new NPCs (tab "NPCs"): a name, the look of a game NPC, and a role. A *talking* NPC says your text in the game's own speech window; a *trader* also opens the game's trade window with the goods of a town NPC you choose. Place them like other NPCs and export. For quest mods an NPC can get other texts from a quest stage on. |
| **New textures** | "Recolour the model" (tab Models) makes a copy of a game model with a new colour, a tiling material (e.g. CC0) or a picture of your own as texture, e.g. a gold statue (see [docs](docs/technical.md#new-textures-on-game-models)). |
| **Own 3D models** | "Import a 3D model" (tab Models) turns an OBJ or glTF mesh (e.g. a free CC0 model) into a game model with your texture (see [docs](docs/technical.md#own-3d-models)). Imported and recoloured models are listed under "Own models". |
| **Layout tools** | Mirror a selection, copies in a circle or arc, a ruler (M), a scatter brush, groups of objects per map (Ctrl+G), building kits that work in every map and project. |
| **View** | Minimap (N), "Collision only" for painting, compare with the game's original map (C), day/dusk/night light, an undo list to jump back several steps. |
| **Game objects** | Draw NPC walking paths, add groups of monsters, edit and add HD point lights. |
| **Projects** | Separate projects, each with its own maps, NPCs, mod info and drafts. |
| **Acts** | With the d2r-world-mods tools next to the editor: new dungeon areas, bosses with their loot and the quest chain with Quest Log texts, built and exported from the editor. |
| **Ground** | Paint the ground with terrain stamps (a mask and up to three ground layers of the biome); stamps and effects (fire, fog, flies) are drawn in the view. |
| **Collision in quarters** | Block or clear quarter tiles (5 x 5 units) with the game's own invisible tiles. |
| **Loot** | Edit treasure classes: what the chests of an act, bosses and monsters drop. |
| **Maps** | Tabs for open maps (unsaved work stays as a draft), new maps from a copy of a map, "Where used?" for models, pictures in the model list. |
| **Play here** | Export and start the game right at the view centre of a map (maps of their own level); in the act editor, a test visits every area of the act. |
| **Mods** | Check two exported mods for files both change and merge them into a new mod (data tables and texts row by row). |
| **Options** | Camera, grid, autosave, undo steps, labels, previews, minimap, own keyboard shortcuts; a right-click menu on objects and a short tour at the first start. |
| **Legacy graphics** | View the map in the old SD graphics. |
| **Screenshots** | Save a picture of the view as PNG (toolbar button), without the gizmo and grid. |
| **Export** | Writes the mod into `<game>/mods/<Name>/`. Your edits never touch the game's own files. The export dialog checks the project first (missing models, objects outside the map, unsaved drafts), takes the mod's title, version and description, and can make a zip with an install README for uploading. |
| **Test in game** | Exports and runs an automatic test in the game: are the edits there, and do blocked tiles stop the player? |

Unsaved work is autosaved every 60 seconds and offered again when you reopen the map.

**Updates:** the editor looks for a new release when it starts. Click "Update now", then
"Restart now": the program is replaced and the window reloads. Your maps and settings stay.

## Controls

| Key or mouse | Action |
|---|---|
| Left click / drag | select / selection rectangle (Shift adds) |
| Right mouse / middle mouse / wheel | orbit / pan / zoom |
| W / E / R | move / rotate / scale |
| Del, Ctrl+D, Ctrl+A | delete, duplicate, select all |
| Ctrl+C / Ctrl+V | copy / paste at the cursor |
| Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) | undo / redo |
| Arrow keys, Page Up/Down | move one grid step (Shift: ten), change height |
| F, G, T | focus selection, drop to ground, top-down view |
| P, Shift+P, O | place the previewed model, scatter it, add a game object at the cursor |
| H, Shift+H | hide the selection, show hidden objects |
| Ctrl+1..4, 1..4 | store a camera view of the map, go back to it |
| Q, B, X, [ ] | objects tool, block, clear collision, brush size |
| L | gizmo in world or object axes |
| M, N, C | ruler, minimap, compare with the original |
| Ctrl+G | save the selection as a group |
| ? or F1 | keyboard and mouse help |
| Esc | deselect |

## Good to know

- **Shared pieces:** random outdoor levels are built from shared map pieces. Editing one changes
  every place where the game uses it; the editor warns you when you open such a map.
- **Collision** works per tile (1 tile = 10 × 10 units), not finer.
- **Prefabs** are shared too. Use "Explode prefab" to edit one on a single map.
- The ground shows one main layer per map, not the game's full blend of several layers.
- Character models are shown without animation.
- New NPCs show the game's default menu (Talk, Trade, Cancel), also when they only talk.

## Building from source

Windows, Visual Studio 2022 Build Tools (x64), Python 3.14 with numpy and Pillow, Node.js.

| Part | How |
|---|---|
| three.js | `cd web` and `npm install` |
| CascLib | clone [CascLib](https://github.com/ladislav-zezula/CascLib) to `third_party/CascLib`, run `tools\build_casclib.cmd` |
| BitKnit decoder | clone [pybg3](https://github.com/eiz/pybg3) to `third_party/pybg3`, run `native\build.cmd` |
| Plugins | D2RLoader plugin SDK headers in `third_party/PluginSDK/include` (or `D2RL_SDK`), run `plugin\build.cmd`, `plugin\build_harness.cmd` and `plugin\build_npc.cmd` |
| Launcher | `launcher\build.cmd` |
| Package | `python -I tools/build_app.py` (own copy) or `--release` (zip) |

`start_editor.cmd` runs the editor from the source folder at http://127.0.0.1:8765/.
How it works inside (file formats, collision, the in-game test, game functions):
[docs/technical.md](docs/technical.md).

## License

MIT, see [LICENSE](LICENSE). Third-party parts: [THIRD_PARTY.md](THIRD_PARTY.md).
Diablo II: Resurrected is a trademark of Blizzard Entertainment; this project is not affiliated
with Blizzard.
