"""Update the editor program from the GitHub releases.

Only the packaged program (D2REditor.exe next to app/ and runtime/) updates itself; a source
checkout is updated with git. The steps:

  check()     asks GitHub for the latest release and compares its version with app/VERSION
  download()  fetches the release zip in a background thread and unpacks D2REditor.exe, app/ and
              runtime/ into <program>/update_staging/ (data/ is never touched)
  then the server exits with code 4; the launcher swaps the staged parts in, starts the new
  server, and the open editor window reloads itself.

D2R_EDITOR_UPDATE_URL replaces the GitHub address (a JSON file in the format of the GitHub
"latest release" answer), for tests.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import threading
import time
import urllib.request
import zipfile

REPO = "notenoughsp/d2r-level-editor"
FEED = os.environ.get("D2R_EDITOR_UPDATE_URL") or f"https://api.github.com/repos/{REPO}/releases/latest"
APP = pathlib.Path(__file__).resolve().parent.parent          # app/ (or the source checkout)
PROGRAM = APP.parent                                            # folder of D2REditor.exe
STAGING = PROGRAM / "update_staging"
EXIT_CODE = 4                                                   # tells the launcher to swap and restart
PARTS = ("D2REditor.exe", "app", "runtime")

state = {"phase": "idle", "done": 0, "total": 0, "error": "", "version": ""}
_cache = {"time": 0.0, "answer": None}
_lock = threading.Lock()


def current_version():
    f = APP / "VERSION"
    return f.read_text(encoding="utf-8").strip() if f.exists() else "0.0.0"


def packaged():
    return APP.name == "app" and (PROGRAM / "D2REditor.exe").exists() and (PROGRAM / "runtime").is_dir()


def parse(v):
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3]) or (0,)


def _get(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "d2r-level-editor-updater",
                                               "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(req, timeout=timeout)


def check(force=False):
    """{"current", "latest", "newer", "notes", "page", "packaged"}; asks GitHub at most once an hour."""
    if not force and _cache["answer"] and time.time() - _cache["time"] < 3600:
        return _cache["answer"]
    answer = {"current": current_version(), "packaged": packaged(), "latest": "", "newer": False}
    try:
        with _get(FEED) as r:
            rel = json.loads(r.read().decode("utf-8"))
        assets = [a for a in rel.get("assets", []) if a.get("name", "").lower().endswith(".zip")]
        latest = rel.get("tag_name", "").lstrip("v")
        answer.update(latest=latest, notes=(rel.get("body") or "")[:2000], page=rel.get("html_url", ""),
                      newer=bool(assets) and parse(latest) > parse(answer["current"]))
        if assets:
            answer["_asset"] = {"url": assets[0]["browser_download_url"], "size": assets[0].get("size", 0),
                                "digest": assets[0].get("digest") or ""}
    except Exception as e:  # offline, rate limit: no update offered
        answer["error"] = str(e)
    _cache.update(time=time.time(), answer=answer)
    return answer


def public(answer):
    return {k: v for k, v in answer.items() if not k.startswith("_")}


def _download(asset, version):
    try:
        url = asset["url"]
        if not url.startswith("https://") and not os.environ.get("D2R_EDITOR_UPDATE_URL"):
            raise ValueError("update address is not https")
        if STAGING.exists():
            shutil.rmtree(STAGING)
        STAGING.mkdir(parents=True)
        zpath = STAGING / "update.zip"
        sha = hashlib.sha256()
        with _get(url, timeout=60) as r, open(zpath, "wb") as f:
            state["total"] = int(r.headers.get("Content-Length") or asset.get("size") or 0)
            while True:
                block = r.read(1 << 16)
                if not block:
                    break
                f.write(block)
                sha.update(block)
                state["done"] += len(block)
        want = asset.get("digest", "")
        if want.startswith("sha256:") and want[7:].lower() != sha.hexdigest():
            raise ValueError("the downloaded file is damaged (checksum)")
        state["phase"] = "unpacking"
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            exe = next((n for n in names if n.replace("\\", "/").split("/")[-1] == "D2REditor.exe"), None)
            if not exe:
                raise ValueError("the release zip has no D2REditor.exe")
            prefix = exe[: -len("D2REditor.exe")]
            out = STAGING / "new"
            for n in names:
                rel = n[len(prefix):] if n.startswith(prefix) else None
                if not rel or rel.endswith("/") or rel.split("/")[0] not in PARTS:
                    continue  # only the program parts; never data/
                dst = (out / rel).resolve()
                if not dst.is_relative_to(out.resolve()):
                    continue  # no paths outside the staging folder
                dst.parent.mkdir(parents=True, exist_ok=True)
                with z.open(n) as src, open(dst, "wb") as f:
                    shutil.copyfileobj(src, f)
        zpath.unlink()
        if not all((out / p).exists() for p in PARTS):
            raise ValueError("the release zip is incomplete")
        (STAGING / "ready.txt").write_text(version + "\n", encoding="utf-8")
        state["phase"] = "ready"
    except Exception as e:
        state.update(phase="error", error=str(e))
        shutil.rmtree(STAGING, ignore_errors=True)


def download():
    with _lock:
        if state["phase"] in ("downloading", "unpacking"):
            return state
        if not packaged():
            return {**state, "phase": "error", "error": "only the packaged program updates itself"}
        answer = check()
        if not answer.get("newer"):
            return {**state, "phase": "error", "error": "no newer version"}
        state.update(phase="downloading", done=0, total=0, error="", version=answer["latest"])
        threading.Thread(target=_download, args=(answer["_asset"], answer["latest"]), daemon=True).start()
        return state


def apply_and_exit():
    """The launcher swaps the parts in once the server has ended with EXIT_CODE."""
    if state["phase"] != "ready" or not (STAGING / "ready.txt").exists():
        return False
    threading.Timer(0.5, lambda: os._exit(EXIT_CODE)).start()
    return True
