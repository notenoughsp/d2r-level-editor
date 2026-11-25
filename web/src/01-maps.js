// ---------- asset loading ----------
// Many models share textures: three.js's file cache keeps each texture once (one request, one decode).
// Only textures are kept there; models are kept as scenes in modelCache, their bytes are not needed again.
THREE.Cache.enabled = true;
const cacheAdd = THREE.Cache.add.bind(THREE.Cache);
THREE.Cache.add = (key, file) => { if (String(key).includes("/api/texture")) cacheAdd(key, file); };
const loader = new GLTFLoader();
const modelCache = new Map();
const ASSET_VERSION = 5; // bump when the server-side model conversion changes (busts browser caches)
let lod = 1;

let loadsPending = 0, loadsDone = 0;
function updateProgress() {
  const el = $("#progress");
  if (loadsPending === 0) { el.classList.add("hidden"); loadsDone = 0; return; }
  el.classList.remove("hidden");
  const total = loadsPending + loadsDone;
  $("#progress-bar").style.width = `${Math.round((loadsDone / total) * 100)}%`;
  $("#progress-text").textContent = `Loading models: ${loadsDone} / ${total}`;
}
function trackLoad(promise) {
  loadsPending++;
  updateProgress();
  promise.finally(() => { loadsPending--; loadsDone++; updateProgress(); });
  return promise;
}

function loadModel(path) {
  const key = `${path}|${lod}`;
  if (!modelCache.has(key)) {
    modelCache.set(key, trackLoad(new Promise((resolve) => {
      loader.load(api("model", { v: ASSET_VERSION, lod, path }), (g) => {
        g.scene.traverse((o) => {
          if (o.isMesh && o.material && o.material.map) o.material.map.colorSpace = THREE.SRGBColorSpace;
        });
        resolve(g.scene);
      }, undefined, () => { modelCache.delete(key); resolve(null); });
    })));
  }
  return modelCache.get(key);
}

function placeholder() {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xc7a35a, wireframe: true }));
  m.userData.placeholder = true;
  return m;
}

// Symbols for entities without a model (lights, effects, sounds, decals...)
const HELPER_KINDS = [
  ["SpotLightDefinitionComponent", 0xffe066, "Light"], ["PointLightDefinitionComponent", 0xffe066, "Light"],
  ["VfxDefinitionComponent", 0xc77dff, "Effect"], ["AudioEmitterComponent", 0x5aa9ff, "Sound"],
  ["TerrainStampDefinitionComponent", 0xb08050, "Terrain stamp"], ["TerrainDecalDefinitionComponent", 0xb08050, "Decal"],
];
const helperGeometry = new THREE.OctahedronGeometry(1.2);
let showHelpers = true;
function helperMarker(ent) {
  const kind = HELPER_KINDS.find(([t]) => comp(ent, t)) || [null, 0x9a9a9a, "Other"];
  const m = new THREE.Mesh(helperGeometry, new THREE.MeshBasicMaterial({ color: kind[1], wireframe: true }));
  m.position.y = 1.5;
  m.userData.helper = kind[2];
  helperMarkers.add(m);
  return m;
}
// Lights store their radius in the entity scale; keep the symbols the same size regardless.
const helperMarkers = new Set();
function keepMarkersUnscaled() {
  for (const m of helperMarkers) {
    let top = m;
    while (top.parent) top = top.parent;
    if (top !== scene) { helperMarkers.delete(m); continue; }  // its map was closed
    const s = m.parent.scale;
    m.scale.set(1 / (s.x || 1), 1 / (s.y || 1), 1 / (s.z || 1));
    m.position.y = 1.5 / (s.y || 1);
  }
}

// ---------- preset model ----------
let doc = null;            // parsed preset JSON
let presetPath = null;
let root = null;           // THREE.Group with all entities
const entityObjects = new Map(); // entity id -> THREE.Group
let selection = [];        // selected entity groups (last = primary)
const selectionBoxes = [];
const hiddenIds = new Set(); // objects hidden in the view (H), by entity id
let dirty = false;
let links = {};            // entity id -> [[tx, ty], ...] collision tiles blocked for that object
let restoredDraft = false;
const undoStack = [];

const comp = (ent, type) => ent.components.find((c) => c.type === type);
const primary = () => selection[selection.length - 1] || null;

function applyTransform(obj, ent) {
  const t = comp(ent, "TransformDefinitionComponent");
  if (!t) return;
  obj.position.set(t.position.x, t.position.y, t.position.z);
  obj.quaternion.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
  obj.scale.set(t.scale.x, t.scale.y, t.scale.z);
}

function writeTransform(obj) {
  const t = comp(obj.userData.entity, "TransformDefinitionComponent");
  if (!t) return;
  const r = (v) => Math.round(v * 1e6) / 1e6;
  t.position = { x: r(obj.position.x), y: r(obj.position.y), z: r(obj.position.z) };
  t.orientation = { x: r(obj.quaternion.x), y: r(obj.quaternion.y), z: r(obj.quaternion.z), w: r(obj.quaternion.w) };
  t.scale = { x: r(obj.scale.x), y: r(obj.scale.y), z: r(obj.scale.z) };
}

async function buildEntity(ent, parent, depth = 0) {
  const g = new THREE.Group();
  g.name = ent.name;
  applyTransform(g, ent);
  parent.add(g);
  const md = comp(ent, "ModelDefinitionComponent");
  const pf = comp(ent, "PrefabPlacementDefinitionComponent");
  if (md && md.filename && comp(ent, "TerrainDefinitionComponent")) {
    g.userData.terrain = true; // ground mesh: neutral colour, not selectable
    loadModel(md.filename).then((m) => m && g.add(terrainObject(m)));
  } else if (md && md.filename) {
    const ph = placeholder();
    g.add(ph);
    loadModel(md.filename).then((m) => {
      g.remove(ph);
      g.add(m ? m.clone(true) : placeholder());
    });
  } else if (pf && pf.prefab && depth < 4) {
    try {
      const sub = await (await fetch(api("preset", { path: pf.prefab }))).json();
      for (const e of sub.entities || []) buildEntity(e, g, depth + 1);
    } catch {
      g.add(placeholder());
    }
  } else if (depth === 0 && comp(ent, "TransformDefinitionComponent")) {
    const marker = helperMarker(ent);
    marker.visible = showHelpers;
    g.add(marker);
    const fx = fxFor(ent);
    if (fx) g.add(fx);
    const st = stampPlane(ent);
    if (st) g.add(st);
  } else {
    g.visible = false;
  }
  return g;
}

async function addObjectFor(ent, into = root) {
  const obj = await buildEntity(ent, into);
  obj.userData.entity = ent;
  entityObjects.set(ent.id, obj);
  return obj;
}

let loadToken = 0;  // the newest openPreset call; older ones stop when it changes
function recentMaps() { return JSON.parse(localStorage.getItem("recentMaps") || "[]"); }
function rememberView() {
  if (presetPath) localStorage.setItem("lastView:" + presetPath, JSON.stringify({ p: camera.position.toArray(), t: orbit.target.toArray() }));
}
window.addEventListener("pagehide", rememberView);
async function openPreset(path, opts = {}) {
  if (dirty && !opts.fromTab) await keepAsDraft();  // unsaved work stays as a draft of its tab
  addTab(path);
  rememberView();
  localStorage.setItem("recentMaps", JSON.stringify([path, ...recentMaps().filter((p) => p !== path)].slice(0, 12)));
  renderPresets();
  hiddenIds.clear();
  if (compareRoot) { scene.remove(compareRoot); compareRoot = null; $("#btn-compare").classList.remove("active"); }
  setTimeout(renderGroups, 0);
  const token = ++loadToken;
  const stale = () => token !== loadToken;
  setStatus(`Loading ${path} …`);
  selectGameObject(null);
  select([]);
  if (root) scene.remove(root);
  root = new THREE.Group();
  const myRoot = root;
  scene.add(root);
  entityObjects.clear();
  undoStack.length = 0;
  redoStack.length = 0;
  presetPath = path;
  $("#empty-hint").classList.add("hidden");
  renderTabs();
  const loaded = await (await fetch(api("preset", { path }))).json();
  if (stale()) return;
  doc = loaded;
  if (!Array.isArray(doc.entities)) {
    setStatus(`Could not load the map: ${path}${doc.error ? ` (${doc.error})` : ""}`);
    doc = { entities: [] };
    dirty = false;
    updateTitle();
    return;
  }
  const draft = await (await fetch(api("draft", { path }))).json();
  if (stale()) return;
  const tabDraft = mapTabs.find((t) => t.path === path && t.draft);
  if (draft.doc) {
    const when = new Date(draft.time * 1000).toLocaleString(locale());
    if (tabDraft || confirm(`There is an autosaved, unsaved draft of this map from ${when}. Restore it?`)) {
      doc = draft.doc;
      restoredDraft = true;
    } else await postJSON("draft", { path });
  }
  links = await (await fetch(api("links", { path }))).json();
  await loadBiomeMaterial(doc.biomeFilename);
  if (stale()) return;
  fillReplaceList(path);
  // The ground is either a terrain entity in the list or the mesh next to the json
  // (<name>/terrain_lod0.model).
  if (!doc.entities.some((e) => comp(e, "TerrainDefinitionComponent"))) {
    loadModel(path.replace(/\.json$/, "/terrain_lod0.model")).then((m) => m && myRoot.add(terrainObject(m)));
  }
  let n = 0;
  const myDoc = doc;
  for (const ent of myDoc.entities) {
    if (stale()) return;  // another map was opened meanwhile
    await addObjectFor(ent, myRoot);
    if (++n % 200 === 0) setStatus(`Loading entities ${n}/${myDoc.entities.length} …`);
  }
  if (stale()) return;
  dirty = restoredDraft;
  restoredDraft = false;
  const last = JSON.parse(localStorage.getItem("lastView:" + path) || "null");
  if (last) {  // back where you left this map
    camera.position.fromArray(last.p);
    orbit.target.fromArray(last.t);
    orbit.update();
  } else frameAll();
  updateSceneInfo();
  loadCollision();
  loadGameObjects();
  renderObjectList();
  showPresetInfo(path);
  loadLocks();
  showNote();
  applyWireframe();
  setStatus(`${path} loaded`);
  document.querySelectorAll("#preset-list li").forEach((li) => li.classList.toggle("active", li.dataset.path === path));
  if (sd.on) { sd.path = null; sdLoad(); }  // the legacy view shows the newly opened map
}

// The terrain mesh has no textures of its own (the game paints it from biome tiles), so it is
// drawn in a neutral earth colour and cannot be selected.
const terrainMaterial = new THREE.MeshStandardMaterial({ color: 0x4a4232, roughness: 1 });
// The game paints the terrain from the biome's terrain layers (blended per tile through
// tile_masks.json). The editor shows the biome's main ground layer (grass where there is one),
// tiled in world space, which is close enough to read the map.
let biomeMaterial = null;
const TERRAIN_REPEAT = 20;  // world units per texture repeat
async function loadBiomeMaterial(biome) {
  biomeMaterial = null;
  if (!biome) return;
  try {
    const b = await (await fetch(api("preset", { path: biome }))).json();
    const layers = (b.terrainDataUltra || b.terrainDataHigh || {}).terrainLayers || [];
    biomeLayers = layers;
    if ($("#st-box").open) loadStampMasks();
    const pick = layers.find((l) => /grass/i.test(l.name) && l.Albedo) || layers.find((l) => !/path|puddle|river/i.test(l.name) && l.Albedo) || layers[0];
    if (!pick || !pick.Albedo) return;
    const tex = await new THREE.TextureLoader().loadAsync(api("texture", { path: pick.Albedo }));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    biomeMaterial = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, color: 0xd8d8d8 });
    biomeMaterial.userData.layer = pick.name;
  } catch (e) {
    console.warn("biome texture", e);
  }
}
// ---------- replace a map by a copy of another one of the same size ----------
async function fillReplaceList(path) {
  const sel = $("#replace-src");
  sel.length = 1;
  try {
    const r = await (await fetch(api("samesize", { path }))).json();
    for (const p of r.presets) {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = p.replace("data/hd/env/preset/", "");
      sel.appendChild(o);
    }
    sel.options[0].textContent = `Take over a map of the same size … (${r.presets.length}, experimental)`;
  } catch (e) {
    console.warn("same size list", e);
  }
}
$("#replace-btn").addEventListener("click", async () => {
  const src = $("#replace-src").value;
  if (!presetPath || !src) return;
  if (!confirm(`${presetPath.replace("data/hd/env/preset/", "")} will be replaced by a copy of ${src.replace("data/hd/env/preset/", "")}. Continue?`)) return;
  const { ok, data: j } = await postJSON("replace", { path: presetPath, source: src });
  if (!ok) return setStatus(`Replacing failed: ${j.error}`);
  dirty = false;
  await openPreset(presetPath);
  setStatus(`Replaced by ${src.replace("data/hd/env/preset/", "")}: ${j.files} file(s)`);
});

// ---------- legacy (SD) view: the map drawn from its DS1 tiles with the old graphics ----------
const sd = { on: false, scale: 0.25, x: 0, y: 0, meta: null, path: null, drag: null };
function sdApply() {
  $("#sd-img").style.transform = `translate(${sd.x}px, ${sd.y}px) scale(${sd.scale})`;
}
async function sdLoad() {
  if (!presetPath || sd.path === presetPath) return;
  sd.path = presetPath;
  setStatus("Drawing the legacy graphics …");
  sd.meta = await (await fetch(api("sd", { path: presetPath, meta: 1 }))).json();
  const img = $("#sd-img");
  await new Promise((ok) => { img.onload = ok; img.onerror = ok; img.src = api("sd", { path: presetPath, v: Date.now() }); });
  const box = $("#viewport").getBoundingClientRect();
  sd.scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  sd.x = (box.width - img.naturalWidth * sd.scale) / 2;
  sd.y = (box.height - img.naturalHeight * sd.scale) / 2;
  sdApply();
  setStatus("Legacy graphics");
}
async function sdToggle(on = !sd.on) {
  sd.on = on;
  $("#sd-view").classList.toggle("hidden", !on);
  $("#btn-sd").classList.toggle("active", on);
  if (on) {
    sd.path = null;  // redraw: collision edits change the tiles
    await sdLoad();
  }
}
$("#btn-sd").addEventListener("click", () => sdToggle());
$("#sd-view").addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = $("#sd-view").getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const f = e.deltaY < 0 ? 1.2 : 1 / 1.2;
  sd.x = mx - (mx - sd.x) * f;
  sd.y = my - (my - sd.y) * f;
  sd.scale *= f;
  sdApply();
}, { passive: false });
$("#sd-view").addEventListener("pointerdown", (e) => {
  sd.drag = { x: e.clientX - sd.x, y: e.clientY - sd.y };
  $("#sd-view").classList.add("dragging");
});
window.addEventListener("pointermove", (e) => {
  if (!sd.drag) return;
  sd.x = e.clientX - sd.drag.x;
  sd.y = e.clientY - sd.drag.y;
  sdApply();
});
window.addEventListener("pointerup", () => { sd.drag = null; $("#sd-view").classList.remove("dragging"); });
$("#sd-view").addEventListener("dblclick", (e) => {
  // image pixel -> tile: (x - y) * 80 = px - originX, (x + y) * 40 = py - top
  const r = $("#sd-view").getBoundingClientRect();
  const px = (e.clientX - r.left - sd.x) / sd.scale, py = (e.clientY - r.top - sd.y) / sd.scale;
  const a = (px - sd.meta.originX) / 80, b = (py - sd.meta.top) / 40;
  const tx = (a + b) / 2, ty = (b - a) / 2;
  sdToggle(false);
  const target = new THREE.Vector3(tx * 10, 0, ty * 10);
  const off = camera.position.clone().sub(orbit.target);
  orbit.target.copy(target);
  camera.position.copy(target).add(off);
  setStatus(`Tile ${Math.floor(tx)}, ${Math.floor(ty)}`);
});

function terrainObject(m) {
  const t = m.clone(true);
  t.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  t.traverse((o) => {
    if (!o.isMesh) return;
    if (biomeMaterial) {
      o.geometry = o.geometry.clone();
      const pos = o.geometry.attributes.position;
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        uv[i * 2] = v.x / TERRAIN_REPEAT;
        uv[i * 2 + 1] = v.z / TERRAIN_REPEAT;
      }
      o.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    }
    o.material = biomeMaterial || terrainMaterial;
  });
  t.userData.terrain = true;
  return t;
}

function frameAll() {
  const box = new THREE.Box3();
  for (const obj of entityObjects.values()) box.expandByPoint(obj.position);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  orbit.target.copy(c);
  camera.position.set(c.x, c.y + size * 0.7, c.z + size * 0.7);
  grid.position.set(Math.round(c.x), -0.05, Math.round(c.z));
}

function updateSceneInfo() {
  if (!doc) return;
  const models = doc.entities.filter((e) => comp(e, "ModelDefinitionComponent")).length;
  const helpers = doc.entities.filter((e) => !comp(e, "ModelDefinitionComponent") && !comp(e, "PrefabPlacementDefinitionComponent")).length;
  updateTitle();
  const shortName = presetPath ? presetPath.replace("data/hd/env/preset/", "") : doc.name;
  $("#scene-info").innerHTML = `<b>${shortName}</b><br>${doc.entities.length} objects: ${models} models, ${helpers} helper objects<br>` +
    `Biome: ${doc.biomeFilename || "-"}<br>${dirty ? "<span style='color:#c7a35a'>unsaved</span>" : "saved"}`;
}

// a text with the search hit marked (case ignored)
// search fields: every word must appear somewhere ("town e1" finds act1/town/towne1)
const words = (q) => (q || "").toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text, q) => { const t = (text || "").toLowerCase(); return words(q).every((w) => t.includes(w)); };
// the text with each search word marked
function marked(text, q) {
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase(), hit = new Array(text.length).fill(false);
  for (const w of words(q)) for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + 1)) hit.fill(true, i, i + w.length);
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && hit[j] === hit[i]) j++;
    if (hit[i]) { const mk = document.createElement("mark"); mk.textContent = text.slice(i, j); frag.append(mk); }
    else frag.append(document.createTextNode(text.slice(i, j)));
    i = j;
  }
  return frag;
}
function updateTitle() {
  const name = presetPath ? presetPath.replace("data/hd/env/preset/", "") : "";
  const proj = window.projectName && window.projectName !== "Default" ? ` [${window.projectName}]` : "";
  document.title = `${dirty ? "● " : ""}${name ? name + " – " : ""}D2R Level Editor${proj}`;
  $("#btn-save").classList.toggle("dirty", dirty);
  updateUndoButtons();
}
function markDirty() {
  if (!dirty) setTimeout(renderTabs, 0);
  dirty = true;
  updateSceneInfo();
  scheduleObjectList();
}
