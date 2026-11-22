# D2R Level Editor

A 3D editor for Diablo II: Resurrected HD maps. It reads the game's own models, textures
and map presets directly from the installed game (CASC storage, read-only). You can place,
move, rotate and scale objects and export the result as a mod.

**Download:** the ready-to-run program is in the GitHub releases (`D2R Level Editor (release).zip`):
unpack it and start `D2REditor.exe`. It needs Diablo II: Resurrected and
[D2RLoader](https://d2rloader.net) to play the exported mods, and Edge or Chrome for the editor
window. The game files are read from your own installation; this repository and the release
contain no game data.

## Start

**Program folder (no install):** `dist\D2R Level Editor\D2REditor.exe`. It starts the editor
server with its own Python copy and opens the editor in an app window (Edge or Chrome `--app`,
own profile). Closing the window stops the server. A second start only opens another window.
If the game is not found, it asks for the game folder once and keeps it in `data\settings.json`.

| Folder | Content |
|---|---|
| `D2REditor.exe` | launcher (`launcher/launcher.cpp`, `launcher/build.cmd`) |
| `runtime\` | copy of Python 3.14 with only the standard library, numpy and Pillow |
| `app\` | server, tools, web editor, CascLib, bitknit, plugins |
| `data\` | project, editor state, asset cache, `settings.json`, `server.log` |

Build it with `launcher\build.cmd`, then:

| Command | Result |
|---|---|
| `python -I tools/build_app.py` | `dist\D2R Level Editor`: your own copy. `data_path.txt` points at this checkout, so the exe and the source folder edit the same maps |
| `python -I tools/build_app.py --release` | `dist\D2R Level Editor (release)` and a zip (about 33 MB) for other people: empty `data\` (no maps, cache, settings or browser profile) |
| `python -I tools/build_app.py --own-data [dir]` | portable copy with its own `data\` (copied once) |

A rebuild replaces `runtime\` and `app\` and never overwrites `data\`. The release was tested on a
simulated clean PC (no Python on PATH, empty data folder, game not found → folder dialog). The
browser profile of the app window is in `editor_state\browser`. The game folder is found through `D2R_GAME`,
`data\settings.json` (`{"game": "<folder>"}`), the Battle.net uninstall entry, or the default.
The game's file list (`assets/listing.tsv`) is built on the first start and again after a game update.

**From the source folder:** `start_editor.cmd` opens http://127.0.0.1:8765/. Requirements:
Python 3 with numpy and Pillow, and the built `third_party/CascLib/build/CascLib.dll` and
`native/bitknit.dll`.

**Language:** the toolbar select switches the editor between Deutsch and English at once
(`web/i18n.js`; the choice is remembered). The launcher follows the Windows display language.

## Building from source

Windows, Visual Studio 2022 Build Tools (x64), Python 3.14 with numpy and Pillow, Node.js (npm).

| Part | How |
|---|---|
| three.js | `cd web` and `npm install` (version from `web/package-lock.json`) |
| CascLib | clone [CascLib](https://github.com/ladislav-zezula/CascLib) to `third_party/CascLib` and run `tools\build_casclib.cmd` (CMake, shared library: `third_party/CascLib/build/CascLib.dll`) |
| BitKnit decoder | clone [pybg3](https://github.com/eiz/pybg3) to `third_party/pybg3`, then `native\build.cmd` (builds `native/bitknit.dll` from `rans.h`) |
| Plugins | the D2RLoader plugin SDK headers (`D2RLPlugin/api.h`) in `third_party/PluginSDK/include` or in the `D2RL_SDK` variable, then `plugin\build.cmd`, `build_harness.cmd`, `build_survival.cmd`, `build_world.cmd` |
| Launcher | `launcher\build.cmd` (`D2REditor.exe`) |
| Packages | `python -I tools/build_app.py` (own copy) or `--release` (zip for others) |

`start_editor.cmd` runs the editor from the source folder.

## Using it

- **Maps** tab: choose an HD map preset (for example `act1/town/towne1.json`).
- **Models** tab: search all ~12,000 HD models. A click shows a rotating preview with its size,
  and a double-click places the model in the view centre. The area select narrows the list (act 1-5,
  global, plants, game objects, characters) or shows the 30 recently used models.
- **Game objects** (game objects from the DS1, used by the game): red cones are NPCs and monster
  spawns (a line shows the walking path), turquoise boxes are objects (chests, waypoints, torches...).
  Select, drag, change the type, delete them, or add new ones ("Add game object", **O** at the
  cursor). A moved NPC takes its path along. Saved straight to the map's DS1 with undo/redo. DS1 files
  with tile groups (196 of 2264) are read-only here, because they do not round-trip exactly.
- The browser tab title shows ● while there are unsaved changes.
- Left click: select. Shift+click adds an object to the selection or removes it. Esc deselects.
  W / E / R: move / rotate / scale gizmo, which also works on several objects together. Del: delete.
  Ctrl+D: duplicate. Ctrl+Z: undo, which also covers collision edits. F: focus the selection.
  Right mouse: orbit, middle mouse: pan, wheel: zoom.
- Grid snap values (move units, degrees, scale step) are set in the toolbar and remembered.
- **Helpers** shows lights (yellow), effects (purple), sounds (blue) and terrain stamps (brown) as
  symbols, so they can be selected and moved too.
- The right panel takes exact position, rotation (degrees) and scale values.
- **Objects** tab: every object of the open map, filterable by name or kind (model, prefab, light,
  effect, sound...). Click selects and focuses, Shift+click adds to the selection.
- **P** places the model shown in the preview at the mouse cursor. Ctrl+Y redoes.
- Dragging with the left mouse button draws a selection rectangle (Shift adds to the selection).
- Ctrl+C / Ctrl+V copy and paste objects at the mouse cursor, also into another map. The group
  keeps its exact layout; only the common offset snaps to the grid.
- Arrow keys move the selection one grid step (Shift: ten), Page Up/Down change the height.
  **G** / "Drop to ground" puts objects onto the terrain height. "Random rotation" turns them at
  random around the vertical axis (useful for plants and rocks). **T** toggles a top-down view.
- The toolbar shows the cursor position in world units and as a DS1 tile. A progress bar shows
  model loading.
- Unsaved work is autosaved as a draft every 60 s (`editor_state/drafts/`). Opening the map
  again offers to restore it, and saving removes it.
- **Explode prefab** (right panel, for a prefab placement) replaces the shared prefab with copies
  of its objects in world space, so they can be edited one by one on this map only.
- When a map opens, a banner tells how the game uses it (from `lvlprest.txt`): a map of its own
  level (with the number of variants), or a reusable piece that random areas may place several times.
- Water materials (no albedo, only normal/foam maps) are drawn translucent blue-green.
- The terrain shows the main ground layer of the map's biome (grass where there is one), tiled in
  world space. The game blends several layers per tile (`tile_masks.json`); the editor does not.
- **Take over a map of the same size** (experimental, right panel under "Map")
  replaces the open map by a copy of another map piece of the same size: DS1 (tiles, collision,
  game objects), HD preset JSON and its terrain files. Earlier project files are kept in
  `editor_state/replaced/<time>/`. In the game test (Blood Moor) one placement of the replaced
  piece showed the new layout and another one the old layout; the cause is not known yet.
- **Test in game** exports the mod and runs the automatic in-game test (below). The result
  window shows each check as PASS or FAIL.
- **Save** writes the preset to `project/data/hd/env/preset/...`. The originals are never touched.
- **Export** copies all saved presets into
  `<game>/mods/<Name>/<Name>.mpq/data/...` and adds `modinfo.json`, a D2RLoader
  `metadata.json` and the fixed-seed plugin (mod-scoped). Start the game with that mod.

## Collision

- Turn on **Collision** to see the gameplay collision of the open map: red = not walkable,
  blue = blocks only line of sight, yellow border = tile changed by you.
- Tool menu **Collision: …** then click or drag over tiles (1 tile = 10 x 10 units). The brush
  select paints 1×1, 3×3 or 5×5 tiles at once:
  - *Collision: block*: tile not walkable
  - *Collision: block + teleport*: also blocks jump/teleport
  - *Collision: clear*: removes the tile's walls (makes a passage)
  - *Collision: original*: restores the tile as shipped
- **Collision under object** (right panel) blocks every tile under the selected models and links
  those tiles to the objects. Moving a linked object moves its collision along, and deleting it frees
  the tiles again. Tiles you painted by hand are never freed by a link. The links are stored in
  `editor_state/links/` (editor only, not exported).
- Edits go to `project/data/global/tiles/<map>.ds1` and are exported with the mod.
- D2R does not read loose `.ds1` files: it preloads every DS1 of an act from
  `data/global/tiles/<act>/combined_ds1.bin` (PresetPreloadCombinedDs1). The export therefore
  rebuilds that file with the edited DS1s (`tools/combined_ds1.py`; format: u32 count,
  count × {u32 offset, u32 size, char name[40]}, data).

How it works: gameplay collision comes from the legacy `.ds1` tile grid, not from the HD models.
Blocking writes the invisible tile `Act1\Outdoors\Blank.dt1` (orientation 0, main 30; sub 1 =
walk, sub 0 = walk + jump) into the first floor layer (HD mode does not draw legacy floor tiles;
"clear"/"original" bring the original floor tile back). An extra floor layer worked in the
towns but crashed the game in random outdoor levels, which merge their pieces with a fixed layer
count (Blood Moor, bord12.ds1, 2026-11-22). DS1 files edited with that older version keep their
extra layer. The game loads Blank.dt1 for every level; in legacy (SD) graphics mode a blocked tile
shows no floor.
HD → DS1 mapping: tile = floor(x / 10), floor(z / 10); subtile = x / 2, z / 2. The subtile flag
order (x = i % 5, y = 4 - i / 5) was checked against the act 1 town walls.

## How it works

| Part | File | Notes |
|---|---|---|
| CASC access | `tools/casc.py` | ctypes wrapper around CascLib (built from source) |
| Textures | `tools/texture.py` | `<DE(` header + mip table; format 0x3E = BC3 sRGB (albedo/normal), 0x3D = BC3 linear (ORM) |
| Models | `tools/gr2.py`, `tools/model_export.py` | Granny 3D, 64-bit, BitKnit2 sections (decoder: pybg3 `rans.h`, MIT). Positions are int16 / 32767 * `ExtendedData.VertexScale`. Converted to GLB |
| Presets | game JSON | entities with TransformDefinitionComponent (position, quaternion, scale) and ModelDefinitionComponent (filename without `_lodN`). New models are added to `dependencies.models` |
| Server | `server.py` | serves the editor, converts models/textures on demand and caches them in `assets/cache/` |
| Editor | `web/` | three.js (npm), OrbitControls + TransformControls + GLTFLoader |
| Fixed seed | `plugin/fixed_seed.cpp` | D2RLoader plugin; hooks DUNGEON_AllocAct (RVA 0x2EF1C0, D2RLoader 1.3.1-beta) and replaces the map seed; config `d2r-fixed-seed.ini` next to the DLL |
| Survival | `plugin/survival.cpp`, `tools/survival_mod.py` | wave survival mod (below) |
| Test plugin | `plugin/test_harness.cpp` | automatic in-game test, exploring, level layout, teleport (below) |

## Automatic in-game test

```
python -I tools/ingame_test.py <ModName> [runs]
```
It needs no mouse, keyboard or screenshots. The script installs `plugin/d2r-test-harness.dll` into
the mod for the test only and starts `D2RLoader.exe -mod <ModName>`. The plugin then:
- puts the window on the second monitor (-3840,0 1600x900) and mutes the game's own audio session,
- enters a game by posting Enter to its own window,
- gives every run a different game seed (GAME_InitAct hook) and logs the server collision
  around the player (`run_<n>.txt`),
- in a second session, runs the character into every blocked edited tile and to one free spot,
  through `CLIENT_UnitDoAction(3 = run, player, x, y)` (RVA 0xFABE0, the function a click calls),
  and logs where the server sees it stop,
- leaves the game with D2RCore `RequestActiveGameShutdown` and exits.

The script finds each edited preset in the logged map by cross-correlation (best match per
folder, at least 98 % agreement) and reports PASS/FAIL for the fixed seed, every edited tile and
every move. The plugin also lists the server units around the player (`units_<n>.txt`: type, class,
x, y); every moved or added DS1 game object must have a unit of its type next to its new position
(NPCs: next to the spawn or a path node). The report goes to `assets/ingame_test_report.txt`. A full run takes about 75 s.
Note: the varied seed is saved into the test character's save (in the mod's own save folder).

**Random areas.** Edited pieces of outdoor levels (`data/global/tiles/<act>/outdoors/`) are not
in the town. The test then reads the room layout of all outdoor levels of that act from the game
and teleports the character through them level by level (about 20 s per level), logging the
collision at enough spots to cover every room. It stops after the level in which the last edited
piece was found (a piece of the Blood Moor needs only that level: about 35 s). Every placement of an edited piece is checked tile by tile; tiles on a
piece's border may be covered by the neighbouring piece (random levels overlap pieces by one tile)
and only count as info. Result of 2026-11-22: the shared piece `bord12.ds1` is placed 9 times in
the act 1 outdoor levels (3 in the Blood Moor), and the edit was active at all 9.

```
python -I tools/explore.py <ModName> --map 2,3   lay out levels 2 and 3 and teleport through them
python -I tools/explore.py <ModName> [legs]      walk out of town, planning each leg from the newest log
python -I tools/explore.py <ModName> --replay    walk the saved route again
```
The test plugin understands these `moves.txt` commands: `x y` (run there), `r dx dy` (run
relative), `t x y` (teleport there in hops of 24 subtiles), `w ms` (wait), `dump` (log map and
units), `plan` (log, then wait for new moves from the script). With `levels=1,2,…` in
`test-harness.ini` it writes the room layout of those levels (`levels_<n>.txt`).

Game functions used (D2RLoader 1.3.1-beta):

| RVA | Function |
|---|---|
| 0x3267C0 | DRLG_GetLevel(version, drlg, levelId): finds or allocates a level (DRLG+0x868 list, level+0x1B8 next) |
| 0x3271C0 | DRLG_InitLevel(version, level): builds the level's rooms (level+0x10 first room) |
| 0x491CA0 | SUNIT_Teleport(game, unit, room or null, x, y, exact, flag): what the Teleport skill calls |
| 0x492CF0 | MONSTERSPAWN_SpawnMonster(game, room, x, y, class, mode, -1, 0x80): spawns a monster pack |
| 0x50ACF0 | room monster population (monster region packs, champions, uniques) |
| 0x408670 | per-game server update, once per frame (game+0x170 frame counter) |

Room (Room2) fields: +0x48 next, +0x50 flags, +0x60/+0x64 position, +0x68/+0x6C size (tiles),
+0x90 level. Level: +0x00 type (1 maze, 2 preset, 3 outdoor), +0x1C8 DRLG, +0x1F8 id.
Game: +0x106 version, +0x12C map seed.

## Wave survival mod

```
python -I tools/survival_mod.py [ModName]      default D2RSurvival, own save folder
```
Outside the towns monsters come in waves around the player: wave n has 6 + 3·(n−1) packs of the
level's own monster types (levels.txt mon/nmon columns), at 10–18 subtiles distance. The next
wave comes 8 s after a wave is cleared, or after 90 s. At most 80 wave monsters live at once. The
normal monster population is turned off outside the towns (act bosses, super uniques and NPCs
come from presets and stay); `--keep-monsters` keeps it. Settings: `d2r-survival.ini` next to the
plugin; log: `d2r-survival.log`. Start the game with `D2RLoader.exe -mod D2RSurvival` and make a
new character (the mod has its own save folder). Not done yet: an in-game wave counter (the
plugin only logs the waves), rewards, difficulty scaling beyond the pack count.
A levels.txt with monster density 0 had no effect on the population, so the plugin does it in
code (the game does read data tables from a mod, see "New areas").

## New areas (zones)

D2RLoader compiles the data tables (`data/global/excel/*.txt`) of a mod at every start, also
without `-txt` (its log: "using current TXT files"). A mod can therefore add rows: new levels and
map pieces. Tested 2026-11-22: a changed lvlprest.txt gave the act 1 town another layout, and a new
level 138 could be entered.

```
python -I tools/new_zone.py zones/<zone>.json   build a new level into project/
python -I tools/give_waypoints.py <save.d2s>     test character: all waypoints (mod save folders only)
```
A zone description (example: `zones/new_tristram.json`) names the new level id, a template level,
the act, a free world offset, the waypoint bit, English names, the template map piece and the
design changes (models and decals to remove, models and game objects to add around a centre).
The script writes into `project/`: `levels.txt` and `lvlprest.txt` with the new rows, the new DS1
(added to the act's `combined_ds1.bin` on export), the HD preset JSON and the level names in
`data/local/lng/strings/levels.json` and `strings-legacy/levels.json` (the game takes level names
from the legacy table). The export adds the `d2r-world` plugin (`plugin/world.cpp`) with a config
made from the zones:

- **Extra towns:** DUNGEON_IsTownLevelId (0x327850) is hard-wired to the five act towns; the
  plugin replaces it so the zone towns count as towns.
- **Coming back:** a character that leaves the game in a new area is brought back to its hub
  town when it joins again (LEVEL_WarpUnit 0x488180, the function a waypoint calls). State per
  character: `d2r-world-state.txt`.

Findings that the script relies on:

| Finding | Consequence |
|---|---|
| A terrain model in a new folder stayed invisible (black ground) | the new preset uses the template's terrain mesh and physics |
| Game object ids of a DS1 are read with the objpreset table of the DS1's tile folder (act1 for Tristram), not of the level's act | object ids in the zone file are act 1 ids for an act1 map piece |
| Level ids may go past 137; 40 waypoint bits exist, bit 39 was free | the first zone uses id 138 and bit 39 |
| The act count (5) is fixed in code: act ranges, waypoint tabs (`tabCount` 5), quests | new areas belong to one of the five acts; a "new act" is a group of new levels of act 5 with its own hub |

The example zone "Sanctuary of New Tristram" (level 138, act 5, world offset 6000/1000) is a
cleaned-up copy of Tristram: corpses, blood, fires and rubble removed; a waypoint, campfire,
stash, braziers, a ring of torches, flowers and statues added. Test of 2026-11-22: the character
travels there with the waypoint function, the HD map and terrain load, and after leaving and
joining again the character is back in the sanctuary. Not checked yet: the act 5 waypoint menu
entry for bit 39 and the level name on screen.

## Limits

- **Collision** works per tile (5 x 5 subtiles). Finer shapes were tried with extra tiles in the
  mod's Blank.dt1 (`collision.SubtileTiles`, not offered in the editor): the game reads the file
  from the mod (changed flags of existing tiles work), but added tiles always come out fully
  blocked, whatever their flags and main index. Only collision created with "Collision under
  object" follows its object.
- **Random levels** are assembled from shared presets. Editing one changes every place it
  is used, and the editor warns about it when such a map opens. Town, boss and other fixed maps are unique.
- Prefabs are shared JSON files: edit them on one map by exploding them ("Explode prefab").
  Editing the prefab file itself is not offered, because it would change every map that uses it.
- The terrain shows one biome layer, not the game's per-tile blend.
- **Legacy graphics** (toolbar) draws the open map with the legacy SD tiles (floors and walls from the
  DS1 and its DT1 files, act palette; `tools/sd_render.py`, `/api/sd`). It is a view: roofs, shadows,
  animated tiles and object sprites are not drawn. Double-click jumps to the place in the HD view.
- Character models (`data/hd/character/...`) are skinned meshes and appear in their bind pose:
  their animations (`combined.animations`) are in a format not decoded yet.
- **New levels** are possible (see "New areas"), but a sixth act is not: the number of acts is
  fixed in the game code.
- In-game test (2026-11-22, act 1 town): HD edits show up, blocked tiles stop the player, and the
  fixed seed gives an identical town for characters with different game seeds. The check used
  `plugin/collision_probe.cpp` (`build_probe.cmd`), a test plugin that writes the server collision
  around the player to `collision-probe.txt`. Do not ship it with a mod.
