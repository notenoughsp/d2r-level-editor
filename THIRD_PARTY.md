# Third-party components

The D2R Level Editor itself is under the MIT License (`LICENSE`).

The D2R Level Editor package contains these components. Their licence texts are in `licenses/`.

| Component | Use | Licence |
|---|---|---|
| [CascLib](https://github.com/ladislav-zezula/CascLib) (Ladislav Zezula) | reads the game's CASC storage (`CascLib.dll`) | MIT |
| [pybg3](https://github.com/eiz/pybg3) `rans.h` | BitKnit2 decoder for Granny models (`native/bitknit.dll`) | MIT |
| [three.js](https://threejs.org) | 3D view of the editor | MIT |
| Python 3.14 runtime | runs the editor server (`runtime/`) | PSF License |
| NumPy | collision and map calculations | BSD-3-Clause |
| Pillow | textures and images | MIT-CMU (HPND) |

Diablo II: Resurrected and its data belong to Blizzard Entertainment. The editor reads the game
files from your own installation and contains none of them. Mods made with it need the game.
This project is not affiliated with or endorsed by Blizzard Entertainment. D2RLoader is a
separate project; the plugins in `app/plugin/` are written for its plugin API.
