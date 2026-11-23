# Technical notes

Details for developers. The [README](../README.md) covers using and building the editor.

## Program folder

`dist\D2R Level Editor\D2REditor.exe` starts the editor server with its own Python copy and opens
the editor in an app window (Edge or Chrome `--app`, own profile). Closing the window stops the
server. A second start only opens another window.

| Folder | Content |
|---|---|
| `D2REditor.exe` | launcher (`launcher/launcher.cpp`, `launcher/build.cmd`) |
| `runtime\` | copy of Python 3.14 with only the standard library, numpy and Pillow |
| `app\` | server, tools, web editor, CascLib, bitknit, plugins |
| `data\` | project, editor state, asset cache, `settings.json`, `server.log` |

| Command | Result |
|---|---|
| `python -I tools/build_app.py` | `dist\D2R Level Editor`: your own copy; `data_path.txt` points at this checkout |
| `python -I tools/build_app.py --release` | `dist\D2R Level Editor (release)` and a zip for other people, with an empty `data\` |
| `python -I tools/build_app.py --own-data [dir]` | portable copy with its own `data\` (copied once) |

A rebuild replaces `runtime\` and `app\` and never overwrites `data\`. The game folder is found
through `D2R_GAME`, `data\settings.json` (`{"game": "<folder>"}`), the Battle.net uninstall entry,
or the default path. The game's file list (`assets/listing.tsv`) is built on the first start and
again after a game update.

## Updates

`tools/updater.py` asks the GitHub API for the latest release (at most once an hour) and compares
its tag with `app/VERSION` (from `VERSION` in the repository). Only the packaged program updates
itself. "Update now" downloads the release zip (checked against the SHA-256 digest GitHub
reports) and unpacks only `D2REditor.exe`, `app\` and `runtime\` into `update_staging\new\`.
"Restart now" ends the server with exit code 4; the launcher renames the old parts to `*.old`,
moves the new ones in, starts the new server on the same port, and the page reloads when
`/api/version` reports the new version. A staged update that was not applied is installed at the
next start. `data\` is never touched. `D2R_EDITOR_UPDATE_URL` points the check at a test feed.

Releases: raise `VERSION`, run `python -I tools/build_app.py --release` (zip
`D2R-Level-Editor-<version>.zip`) and attach the zip to a GitHub release tagged `v<version>`.

## Parts

| Part | File | Notes |
|---|---|---|
| CASC access | `tools/casc.py` | ctypes wrapper around CascLib |
| Textures | `tools/texture.py` | `<DE(` header + mip table; 0x3E = BC3 sRGB, 0x3D = BC3 linear, more in `FORMATS` |
| Models | `tools/gr2.py`, `tools/model_export.py` | Granny 3D, 64-bit, BitKnit2 sections (pybg3 `rans.h`); converted to GLB |
| Presets | game JSON | entities with TransformDefinitionComponent and ModelDefinitionComponent |
| Legacy view | `tools/sd_render.py` | SD tiles from the DS1 and its DT1 files, act palette |
| Server | `server.py` | serves the editor, converts models and textures on demand, caches them in `assets/cache/` |
| Editor | `web/` | three.js (npm): OrbitControls, TransformControls, GLTFLoader |
| Fixed seed | `plugin/fixed_seed.cpp` | hooks DUNGEON_AllocAct (RVA 0x2EF1C0) and replaces the map seed |
| Test plugin | `plugin/test_harness.cpp` | automatic in-game test (below) |

## Collision

Gameplay collision comes from the legacy `.ds1` tile grid, not from the HD models. Blocking
writes the invisible tile `Act1\Outdoors\Blank.dt1` (orientation 0, main 30; sub 1 = walk,
sub 0 = walk + jump) into the first floor layer. HD mode does not draw legacy floor tiles;
"clear" and "original" bring the original floor tile back. An extra floor layer crashed random
outdoor levels, which merge their pieces with a fixed layer count (Blood Moor, bord12.ds1).

HD → DS1: tile = floor(x / 10), floor(z / 10); subtile = x / 2, z / 2. Subtile flag order:
x = i % 5, y = 4 − i / 5 (checked against the act 1 town walls).

D2R does not read loose `.ds1` files: it preloads every DS1 of an act from
`data/global/tiles/<act>/combined_ds1.bin`. The export rebuilds that file with the edited DS1s
(`tools/combined_ds1.py`; format: u32 count, count × {u32 offset, u32 size, char name[40]}, data).

Finer collision was tried with extra tiles in the mod's Blank.dt1 (`collision.SubtileTiles`):
the game reads the file from the mod, but added tiles always come out fully blocked.

## Automatic in-game test

```
python -I tools/ingame_test.py <ModName> [runs]
```
No mouse, keyboard or screenshots. The script installs `plugin/d2r-test-harness.dll` into the
mod for the test only and starts `D2RLoader.exe -mod <ModName>`. The plugin puts the window on
the second monitor and mutes it, enters a game, gives every run a different game seed, logs the
server collision around the player, runs the character into every blocked edited tile
(`CLIENT_UnitDoAction`, RVA 0xFABE0) and lists the server units. The script finds each edited
preset in the logged map by cross-correlation and reports PASS/FAIL to
`assets/ingame_test_report.txt` (about 75 s).

Edited pieces of random outdoor levels are found by reading the room layout of the act's outdoor
levels and teleporting through them until the last edited piece is found. Every placement is
checked tile by tile; border tiles only count as info, because neighbouring pieces overlap.

```
python -I tools/explore.py <ModName> --map 2,3   lay out levels 2 and 3 and teleport through them
python -I tools/explore.py <ModName> [legs]      walk out of town, leg by leg
python -I tools/explore.py <ModName> --replay    walk the saved route again
```
`moves.txt` commands of the test plugin: `x y` (run there), `r dx dy` (relative), `t x y`
(teleport in hops of 24 subtiles), `w ms` (wait), `L id type` (warp to a level), `dump`, `plan`.
`levels=1,2,…` in `test-harness.ini` writes the room layout of those levels.

`plugin/collision_probe.cpp` (`build_probe.cmd`) writes the server collision around the player
to `collision-probe.txt`. It is a test tool; do not ship it with a mod.

## New textures on game models

`python -I tools/retexture.py <model> <tag> tint <r> <g> <b> [strength]` (or `image <picture.png>`)
writes a copy of a game model with new albedo textures into the project, for example a gold
statue next to the original stone one. `<tag>` is four letters or digits.

- **Textures:** `texture.write_texture()` encodes a picture as a D2R `.texture` (BC3 with all
  mips; the header matches the game's own files byte for byte).
- **Model copy:** a `.model` is a Granny file whose materials name their textures by full path.
  The copy is written with uncompressed sections, so the paths can be changed in place (the new
  path has the same length: folder `data/hd/env/tx_<tag>/`, and the first four letters of the
  file name become the tag; with the file name unchanged, two copies showed the same texture).
- **Model list:** the game draws only models listed in `data/hd/model_lod_desc.bin` (FNV-1a hash
  of the lower-case path, bounds, LOD data; sorted 44-byte entries, RVA 0xF75C60/0xF75AF0). The
  copy gets an entry copied from the original model; the project keeps its own copy of that file.

`material <colour map> [repeat]` puts a tiling material on a model, for example a CC0 colour
map from [ambientCG](https://ambientcg.com) (licence: CC0 1.0, free for any use, no credit
needed). The picture is repeated over the texture and keeps the original's light and shadow.
Tested 2026-11-23 with Marble006, Ice002, Metal034, Lava004, Moss002, Rock035, PavingStones092
and Ground054 on statues and pillars ([screenshot](cc0-example.png)).

Tested 2026-11-23 in the act 1 town: a gold and a blue-green marble statue and a red pillar show
next to the originals ([screenshot](retexture-example.png)). A copy of the act 1 barrel stack
(13 textures) did not show; the cause is not known yet.

## Own 3D models

`python -I tools/meshimport.py <mesh.obj | mesh.glb> <new model path> [texture.png] [height]`
turns a mesh of your own (OBJ or binary glTF, e.g. a CC0 model) into a game model, for example
`data/hd/env/model/custom/crystals.model`. Place it in the editor like any other model.

- **Template:** writing a Granny file from scratch needs its whole type tree, so the tool takes
  a game model with one mesh (the act 1 catacomb pillar) and replaces its geometry: the new
  vertices and triangles are appended to the data section and the pointers are moved to them.
  Skeleton, materials and shader settings stay; the albedo becomes the given texture.
- **Vertices** (20 bytes): position int16 x3 + w, normal int8 x3, tangent int8 x3 + sign,
  uv float16 x2. Normals are turned to the side the triangles face (counter-clockwise corners);
  a mesh with normals pointing inward showed black.
- **One LOD:** the new model is listed in `model_lod_desc.bin` with its own bounds and one LOD.
  A model is skipped when a LOD file does not fit the LOD data of its entry: an exact copy of the
  pillar with the LOD 0 mesh in all five LOD files did not show, the same copy with the real
  LOD files did.
- **Scale:** the mesh stands on the ground and is scaled to `height` (default 8; the pillar is
  15 high).

Tested 2026-11-23 in the act 1 town with three meshes made by script: a crystal cluster (Ice002),
a stone needle (Rock035) and a torus knot (Metal034) ([screenshot](custom-models.png)).

## NPC creator

`tools/npc_creator.py` turns the NPC list (`editor_state/npcs.json`) into table rows in both table
sets the game keeps (`data/global/excel/` and `data/global/excel/base/` for classic and LoD
characters): a `monstats.txt` row per NPC (a copy of the look's row with AI `Npc`; its class id
is its row number without the "Expansion" marker rows), an `npc.txt` row for traders (prices),
and a `monpreset.txt` row per act, inserted at the end of the act's block (the game reads each
act's rows as one block). The HD look needs `data/hd/character/npc/<id>.json`, a copy of the
look's file. Names and speech texts are new strings in `npcs.json` (both string folders) with
free ids below 65536. The export adds `plugin/d2r-npc.dll` and its config `d2r-npc.ini`.

What an NPC does is in the game code, per class. The plugin hooks:

| RVA | Function | Hook |
|---|---|---|
| 0x3971A0 | NPC_GetRecord(version, class): 43 town NPC records at 0x237EA60 (0x1C bytes, first a short class) | a new NPC gets a copy of the record of its base NPC (trader: the chosen town NPC, talker: cain1) |
| 0x396800 | vendor stock per class and difficulty | a trader gets the stock of its base NPC |
| 0x1980B0 | NPCMENU_Speak(unit, string id, done): the scrolling speech window | the NPC's own string id (the talking NPC's class is at 0x2A48764) |

Menu entries (client): Talk 0x1161E0, Gossip 0x113340, Trade 0x112C80 (packet 0x38 mode 2).

`python -I tools/npc_ingame_test.py <ModName>` tests the NPCs in the act 1 town without
screenshots: the plugin (with `test_cursor=1`) logs NPC positions, the UI panels that open and
every speech it replaces; the script clicks the NPCs through the plugin's fake mouse, runs the
menu entries through `d2r-npc-action.txt` and checks the log (menu, trade window, own speech).

## Game functions (D2RLoader 1.3.1-beta)

| RVA | Function |
|---|---|
| 0x2EF1C0 | DUNGEON_AllocAct |
| 0xFABE0 | CLIENT_UnitDoAction |
| 0x3267C0 | DRLG_GetLevel(version, drlg, levelId) |
| 0x3271C0 | DRLG_InitLevel(version, level) |
| 0x491CA0 | SUNIT_Teleport(game, unit, room or null, x, y, exact, flag) |
| 0x408670 | per-game server update, once per frame |

Room (Room2): +0x48 next, +0x50 flags, +0x60/+0x64 position, +0x68/+0x6C size (tiles), +0x90
level. Level: +0x00 type (1 maze, 2 preset, 3 outdoor), +0x1C8 DRLG, +0x1F8 id. Game: +0x106
version, +0x12C map seed.
