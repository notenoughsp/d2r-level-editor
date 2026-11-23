"""Build the portable editor folder.

  python -I tools/build_app.py            own copy: dist/D2R Level Editor, shares the data of this
                                          checkout (data_path.txt), so exe and source see the same maps
  python -I tools/build_app.py --release  for other people: dist/D2R Level Editor (release) and a zip,
                                          with an empty data/ folder (no maps, cache, settings or profile)
  python -I tools/build_app.py --own-data [out dir]   portable copy with its own data/ (copied once)

  <out>/D2REditor.exe   launcher (launcher/build.cmd)
  <out>/runtime/        copy of this Python with only the standard library, numpy and Pillow
  <out>/app/            editor program (server, tools, web, native DLLs, plugins)
  <out>/data/           project, editor state, asset cache, settings (kept on later builds)

The folder runs on its own: no Python install, no downloads. Program parts are replaced on
every build; data/ is never overwritten.
"""
import pathlib
import shutil
import sys
import sysconfig

ROOT = pathlib.Path(__file__).resolve().parent.parent
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
RELEASE = "--release" in sys.argv
OWN_DATA = "--own-data" in sys.argv or RELEASE
OUT = pathlib.Path(ARGS[0]) if ARGS else ROOT / "dist" / ("D2R Level Editor (release)" if RELEASE else "D2R Level Editor")
PY = pathlib.Path(sys.base_prefix)

SKIP_LIB = {"site-packages", "test", "idlelib", "tkinter", "turtledemo", "ensurepip", "__pycache__",
            "lib2to3", "pydoc_data"}
PACKAGES = ["numpy", "numpy.libs", "PIL"]
SKIP_DLLS = {"_tkinter.pyd", "tcl86t.dll", "tk86t.dll"}


def ignore_cache(_dir, names):
    return [n for n in names if n == "__pycache__" or n.endswith(".pyc")]


def copy_runtime(dst):
    dst.mkdir(parents=True)
    for f in PY.iterdir():
        if f.is_file() and f.suffix.lower() in (".exe", ".dll"):
            shutil.copy2(f, dst / f.name)
    shutil.copytree(PY / "DLLs", dst / "DLLs", ignore=lambda d, n: [x for x in n if x in SKIP_DLLS])
    lib = PY / "Lib"
    (dst / "Lib").mkdir()
    for f in lib.iterdir():
        if f.name in SKIP_LIB:
            continue
        if f.is_dir():
            shutil.copytree(f, dst / "Lib" / f.name, ignore=ignore_cache)
        else:
            shutil.copy2(f, dst / "Lib" / f.name)
    site = pathlib.Path(sysconfig.get_paths()["purelib"])
    for name in PACKAGES:
        src = site / name
        if not src.exists():
            sys.exit(f"missing package {src}")
        shutil.copytree(src, dst / "Lib" / "site-packages" / name,
                        ignore=lambda d, n: ignore_cache(d, n) + [x for x in n if x == "tests"])


def copy_app(dst):
    dst.mkdir(parents=True)
    shutil.copy2(ROOT / "server.py", dst)
    shutil.copy2(ROOT / "README.md", dst)
    shutil.copy2(ROOT / "VERSION", dst)  # the updater compares it with the latest release
    shutil.copytree(ROOT / "tools", dst / "tools", ignore=ignore_cache)
    web = dst / "web"
    web.mkdir()
    for f in (ROOT / "web").iterdir():
        if f.suffix in (".html", ".css", ".js"):
            shutil.copy2(f, web / f.name)
    three = ROOT / "web" / "node_modules" / "three"
    for part in ("build", "examples/jsm", "LICENSE", "package.json"):
        src, out = three / part, web / "node_modules" / "three" / part
        out.parent.mkdir(parents=True, exist_ok=True)
        (shutil.copytree if src.is_dir() else shutil.copy2)(src, out)
    shutil.copytree(ROOT / "native", dst / "native", ignore=lambda d, n: [x for x in n if not x.endswith(".dll")])
    casc = dst / "third_party" / "CascLib" / "build"
    casc.mkdir(parents=True)
    shutil.copy2(ROOT / "third_party" / "CascLib" / "build" / "CascLib.dll", casc)
    plugin = dst / "plugin"
    plugin.mkdir()
    for f in ("d2r-fixed-seed.dll", "d2r-test-harness.dll"):
        shutil.copy2(ROOT / "plugin" / f, plugin)
    copy_licenses(dst)


def copy_licenses(dst):
    """Third-party licence texts for the release (THIRD_PARTY.md names them)."""
    lic = dst / "licenses"
    lic.mkdir(exist_ok=True)
    shutil.copy2(ROOT / "THIRD_PARTY.md", dst / "THIRD_PARTY.md")
    shutil.copy2(ROOT / "LICENSE", dst / "LICENSE.txt")
    shutil.copy2(ROOT / "third_party" / "CascLib" / "LICENSE", lic / "CascLib.txt")
    shutil.copy2(ROOT / "third_party" / "pybg3" / "LICENSE", lic / "pybg3.txt")
    shutil.copy2(ROOT / "web" / "node_modules" / "three" / "LICENSE", lic / "three.js.txt")
    shutil.copy2(PY / "LICENSE.txt", lic / "Python.txt")
    site = pathlib.Path(sysconfig.get_paths()["purelib"])
    for pkg, out in (("numpy-*.dist-info", "numpy"), ("pillow-*.dist-info", "Pillow")):
        for info in site.glob(pkg):
            for f in list(info.glob("LICENSE*")) + list((info / "licenses").glob("*")):
                if f.is_file():
                    shutil.copy2(f, lic / f"{out}-{f.stem}.txt")


def copy_data(dst):
    dst.mkdir(parents=True)
    for part in ("project", "editor_state"):
        if (ROOT / part).exists():
            shutil.copytree(ROOT / part, dst / part)
    (dst / "assets").mkdir()
    if (ROOT / "assets" / "listing.tsv").exists():
        shutil.copy2(ROOT / "assets" / "listing.tsv", dst / "assets")
    if (ROOT / "assets" / "cache").exists():
        shutil.copytree(ROOT / "assets" / "cache", dst / "assets" / "cache")


def main():
    exe = ROOT / "launcher" / "D2REditor.exe"
    if not exe.exists():
        sys.exit("build launcher/D2REditor.exe first (launcher/build.cmd)")
    OUT.mkdir(parents=True, exist_ok=True)
    for part in ("runtime", "app"):
        if (OUT / part).exists():
            shutil.rmtree(OUT / part)
    copy_runtime(OUT / "runtime")
    copy_app(OUT / "app")
    shutil.copy2(exe, OUT / "D2REditor.exe")
    link = OUT / "data_path.txt"
    if RELEASE:
        link.unlink(missing_ok=True)
        if (OUT / "data").exists():
            shutil.rmtree(OUT / "data")
        (OUT / "data").mkdir()  # the editor fills it on the first start (file list, cache)
    elif OWN_DATA:
        link.unlink(missing_ok=True)
        if not (OUT / "data").exists():
            copy_data(OUT / "data")
    else:
        link.write_text(str(ROOT) + chr(10), encoding="utf-8")
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 2 ** 20
    print(f"built {OUT} ({size:.0f} MB)" + ("" if OWN_DATA else f", data: {ROOT}"))
    if RELEASE:
        version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        zip_path = shutil.make_archive(str(OUT.parent / f"D2R-Level-Editor-{version}"), "zip", OUT.parent, OUT.name)
        print("zip:", zip_path, f"({pathlib.Path(zip_path).stat().st_size / 2 ** 20:.0f} MB)")


if __name__ == "__main__":
    main()
