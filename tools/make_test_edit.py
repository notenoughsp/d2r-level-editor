"""Create an in-game test: a ring of statues around the main campfire of every act 1 town variant,
with blocked collision under each statue. Uses the running editor server (same code paths as the UI).

  python -I make_test_edit.py [port]
"""
import json
import math
import random
import sys
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
API = f"http://127.0.0.1:{PORT}/api"
MODEL = "data/hd/env/model/act2/palace/harem/act2_palace_harem_statues/statue01.model"
PRESETS = [f"data/hd/env/preset/act1/town/{n}.json" for n in ("towne1", "townn1", "towns1", "townw1")]
RADIUS, COUNT, SCALE = 28.0, 6, 1.6


def get(path):
    return json.loads(urllib.request.urlopen(API + path).read())


def post(path, body):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())


def comp(ent, t):
    return next((c for c in ent["components"] if c["type"] == t), None)


for preset in PRESETS:
    doc = get("/preset?path=" + preset)
    doc["entities"] = [e for e in doc["entities"] if not e["name"].startswith("editortest_")]
    fire = next(e for e in doc["entities"] if e["name"] == "pf_town_campfire01_01")
    c = comp(fire, "TransformDefinitionComponent")["position"]
    ids = {e["id"] for e in doc["entities"]}
    ops = []
    for i in range(COUNT):
        a = 2 * math.pi * i / COUNT
        x, z = c["x"] + RADIUS * math.cos(a), c["z"] + RADIUS * math.sin(a)
        # face the fire: rotate around Y
        yaw = math.atan2(c["x"] - x, c["z"] - z)
        eid = random.randrange(1, 0x7FFFFFFF)
        while eid in ids:
            eid = random.randrange(1, 0x7FFFFFFF)
        ids.add(eid)
        name = f"editortest_statue_{i}"
        doc["entities"].append({"type": "Entity", "name": name, "id": eid, "components": [
            {"type": "TransformDefinitionComponent", "name": f"{name}_TransformDefinitionComponent",
             "position": {"x": round(x, 3), "y": 0.0, "z": round(z, 3)},
             "orientation": {"x": 0.0, "y": round(math.sin(yaw / 2), 6), "z": 0.0, "w": round(math.cos(yaw / 2), 6)},
             "scale": {"x": SCALE, "y": SCALE, "z": SCALE}, "inheritOnlyPosition": False},
            {"type": "ModelPlatformTierComponent", "name": f"{name}_ModelPlatformTierComponent",
             "visibilityTier": 0, "shadowTier": 0},
            {"type": "ModelDefinitionComponent", "name": f"{name}_ModelDefinitionComponent", "filename": MODEL,
             "visibleLayers": 1, "lightMask": 19, "shadowMask": 3, "ghostShadows": False, "floorModel": False,
             "terrainBlendEnableYUpBlend": False, "terrainBlendMode": 1},
        ]})
        ops.append({"tx": int(x // 10), "ty": int(z // 10), "mode": "block"})
    deps = doc.setdefault("dependencies", {}).setdefault("models", [])
    if not any(d["path"].lower() == MODEL for d in deps):
        deps.append({"path": MODEL})
    post("/preset?path=" + preset, doc)
    r = post("/collision?path=" + preset, {"ops": ops})
    print(preset, "campfire", (c["x"], c["z"]), "statues", COUNT, "blocked tiles", len(r["edited"]))
