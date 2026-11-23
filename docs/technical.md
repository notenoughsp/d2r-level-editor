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
