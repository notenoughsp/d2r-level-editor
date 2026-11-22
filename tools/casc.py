"""Read Diablo II: Resurrected game files from the CASC storage with CascLib (ctypes).

  python -I casc.py list    <out.tsv>                 list every file (name, size, available)
  python -I casc.py extract <out dir> <glob> [...]    extract files whose name matches a glob

The storage is opened read-only; nothing in the game folder is changed.
"""
import ctypes
import ctypes.wintypes as wt
import fnmatch
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Writable data (project, editor state, asset cache). The packaged editor keeps it apart from the program.
DATA = pathlib.Path(os.environ.get("D2R_EDITOR_DATA") or ROOT)
SETTINGS = DATA / "settings.json"
DLL = ROOT / "third_party" / "CascLib" / "build" / "CascLib.dll"
DEFAULT_GAME = r"C:\Program Files (x86)\Diablo II Resurrected"
UNINSTALL_KEY = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Diablo II Resurrected"


def is_game_dir(path):
    return bool(path) and (pathlib.Path(path) / ".build.info").is_file() and (pathlib.Path(path) / "Data").is_dir()


def find_game():
    """Game folder: D2R_GAME, then settings.json, then the Battle.net uninstall entry, then the default."""
    if os.environ.get("D2R_GAME"):  # set on purpose: use it even when wrong, so the error shows
        return os.environ["D2R_GAME"]
    cands = []
    try:
        cands.append(json.loads(SETTINGS.read_text(encoding="utf-8")).get("game"))
    except (OSError, ValueError):
        pass
    try:
        import winreg
        for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, UNINSTALL_KEY, 0, winreg.KEY_READ | view) as k:
                    cands.append(winreg.QueryValueEx(k, "InstallLocation")[0])
            except OSError:
                pass
    except ImportError:
        pass
    cands.append(DEFAULT_GAME)
    for c in cands:
        if is_game_dir(c):
            return str(pathlib.Path(c))
    return DEFAULT_GAME


GAME = find_game()
MAX_PATH = 260


class FindData(ctypes.Structure):
    _fields_ = [("szFileName", ctypes.c_char * MAX_PATH),
                ("CKey", ctypes.c_ubyte * 16),
                ("EKey", ctypes.c_ubyte * 16),
                ("TagBitMask", ctypes.c_ulonglong),
                ("FileSize", ctypes.c_ulonglong),
                ("szPlainName", ctypes.c_char_p),
                ("dwFileDataId", wt.DWORD),
                ("dwLocaleFlags", wt.DWORD),
                ("dwContentFlags", wt.DWORD),
                ("dwSpanCount", wt.DWORD),
                ("bFileAvailable", wt.DWORD),
                ("NameType", ctypes.c_int)]


class Casc:
    def __init__(self, path=GAME):
        self.lib = ctypes.WinDLL(str(DLL))
        L = self.lib
        L.CascOpenStorage.argtypes = [ctypes.c_char_p, wt.DWORD, ctypes.POINTER(wt.HANDLE)]
        L.CascOpenStorage.restype = ctypes.c_bool
        L.CascFindFirstFile.argtypes = [wt.HANDLE, ctypes.c_char_p, ctypes.POINTER(FindData), ctypes.c_char_p]
        L.CascFindFirstFile.restype = wt.HANDLE
        L.CascFindNextFile.argtypes = [wt.HANDLE, ctypes.POINTER(FindData)]
        L.CascFindNextFile.restype = ctypes.c_bool
        L.CascFindClose.argtypes = [wt.HANDLE]
        L.CascOpenFile.argtypes = [wt.HANDLE, ctypes.c_char_p, wt.DWORD, wt.DWORD, ctypes.POINTER(wt.HANDLE)]
        L.CascOpenFile.restype = ctypes.c_bool
        L.CascGetFileSize64.argtypes = [wt.HANDLE, ctypes.POINTER(ctypes.c_ulonglong)]
        L.CascGetFileSize64.restype = ctypes.c_bool
        L.CascReadFile.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD, ctypes.POINTER(wt.DWORD)]
        L.CascReadFile.restype = ctypes.c_bool
        L.CascCloseFile.argtypes = [wt.HANDLE]
        L.CascCloseStorage.argtypes = [wt.HANDLE]
        self.h = wt.HANDLE()
        if not L.CascOpenStorage(path.encode("mbcs"), 0, ctypes.byref(self.h)):
            raise OSError(f"CascOpenStorage failed: {ctypes.get_last_error() or ctypes.GetLastError()}")

    def files(self):
        fd = FindData()
        hf = self.lib.CascFindFirstFile(self.h, b"*", ctypes.byref(fd), None)
        if not hf or hf == wt.HANDLE(-1).value:
            return
        try:
            while True:
                yield fd.szFileName.decode("utf-8", "replace"), fd.FileSize, bool(fd.bFileAvailable & 1)
                if not self.lib.CascFindNextFile(hf, ctypes.byref(fd)):
                    break
        finally:
            self.lib.CascFindClose(hf)

    def read(self, name):
        hf = wt.HANDLE()
        if not self.lib.CascOpenFile(self.h, name.encode("utf-8"), 0xFFFFFFFF, 0, ctypes.byref(hf)):
            raise OSError(f"open failed: {name}")
        try:
            size = ctypes.c_ulonglong()
            self.lib.CascGetFileSize64(hf, ctypes.byref(size))
            buf = ctypes.create_string_buffer(size.value)
            got = wt.DWORD()
            if not self.lib.CascReadFile(hf, buf, size.value, ctypes.byref(got)):
                raise OSError(f"read failed: {name}")
            return buf.raw[:got.value]
        finally:
            self.lib.CascCloseFile(hf)


def main():
    cmd = sys.argv[1]
    c = Casc()
    if cmd == "list":
        n = 0
        with open(sys.argv[2], "w", encoding="utf-8") as f:
            f.write("name\tsize\tavailable\n")
            for name, size, avail in c.files():
                f.write(f"{name}\t{size}\t{int(avail)}\n")
                n += 1
        print(n, "files")
    elif cmd == "extract":
        out = pathlib.Path(sys.argv[2])
        pats = [p.lower() for p in sys.argv[3:]]
        n = 0
        for name, size, avail in c.files():
            low = name.lower().replace("\\", "/")
            if not avail or not any(fnmatch.fnmatch(low, p) for p in pats):
                continue
            rel = low.split(":", 1)[-1]
            dst = out / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(c.read(name))
            n += 1
        print(n, "files extracted to", out)


if __name__ == "__main__":
    main()
