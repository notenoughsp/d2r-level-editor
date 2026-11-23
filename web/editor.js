// D2R level editor: loads an HD preset (JSON entity list), renders terrain and models, and lets
// the user select (also several objects), move, rotate, scale, add, duplicate and delete entities,
// paint gameplay collision, and save/export/test the result through the local server.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { initI18n, locale, tr } from "./i18n.js?v=13";

initI18n();
const $ = (s) => document.querySelector(s);
const statusEl = $("#status");
const setStatus = (t) => (statusEl.textContent = t);
const api = (path, params = {}) => `/api/${path}?` + new URLSearchParams(params).toString();
async function postJSON(path, params, body) {
  const res = await fetch(api(path, params), {
    method: "POST", headers: { "Content-Type": "application/json", "X-D2R-Editor": "1" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
  return { ok: res.ok, data: await res.json() };
}

// ---------- three.js setup ----------
const viewport = $("#viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15130f);
scene.add(new THREE.HemisphereLight(0xfff4dd, 0x2a2418, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-80, 160, 60);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
camera.position.set(0, 120, 120);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
orbit.enableDamping = true;

const grid = new THREE.GridHelper(1000, 200, 0x3a3326, 0x221f19);
grid.position.y = -0.05; // below the terrain to avoid z-fighting
scene.add(grid);

// The gizmo moves an invisible pivot; the change is applied to every selected object, so the
// same code handles one and many objects.
const pivot = new THREE.Object3D();
scene.add(pivot);
const gizmo = new TransformControls(camera, renderer.domElement);
scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
new ResizeObserver(resize).observe(viewport); // the toolbar may wrap and change the viewport height
resize();
renderer.setAnimationLoop(() => {
  orbit.update();
  for (const b of selectionBoxes) b.update();
  keepMarkersUnscaled();
  renderer.render(scene, camera);
});

// ---------- asset loading ----------
const loader = new GLTFLoader();
const modelCache = new Map();
const ASSET_VERSION = 4; // bump when the server-side model conversion changes (busts browser caches)
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
async function openPreset(path) {
  if (dirty && !confirm("Discard unsaved changes?")) return;
  localStorage.setItem("recentMaps", JSON.stringify([path, ...recentMaps().filter((p) => p !== path)].slice(0, 8)));
  renderPresets();
  hiddenIds.clear();
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
  if (draft.doc) {
    const when = new Date(draft.time * 1000).toLocaleString(locale());
    if (confirm(`There is an autosaved, unsaved draft of this map from ${when}. Restore it?`)) {
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
  frameAll();
  updateSceneInfo();
  loadCollision();
  loadGameObjects();
  renderObjectList();
  showPresetInfo(path);
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

function updateTitle() {
  const name = presetPath ? presetPath.replace("data/hd/env/preset/", "") : "";
  document.title = `${dirty ? "● " : ""}${name ? name + " – " : ""}D2R Level Editor`;
  $("#btn-save").classList.toggle("dirty", dirty);
  updateUndoButtons();
}
function markDirty() {
  dirty = true;
  updateSceneInfo();
  scheduleObjectList();
}

// ---------- selection ----------
const raycaster = new THREE.Raycaster();
let downPos = null;
renderer.domElement.addEventListener("pointerdown", (e) => { if (e.button === 0) downPos = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (tool !== "objects") return;
  if (marquee && marquee.active) return; // handled by the rectangle selection
  if (e.button !== 0 || !downPos || gizmo.dragging) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(p, camera);
  if (gameRoot.visible) {
    const gh = raycaster.intersectObjects(gameRoot.children.map((g) => g.userData.mesh), false)[0];
    if (gh) return selectGameObject(gh.object.parent);
  }
  if (gameSel) selectGameObject(null);
  const hits = root ? raycaster.intersectObject(root, true) : [];
  let hit = null;
  for (const h of hits) {
    if (!h.object.visible) continue;
    let o = h.object;
    while (o && !o.userData.entity) o = o.parent;
    if (o && o.parent === root && !o.userData.terrain && o.visible) { hit = o; break; }
  }
  if (e.shiftKey) {
    if (!hit) return;
    select(selection.includes(hit) ? selection.filter((o) => o !== hit) : [...selection, hit]);
  } else select(hit ? [hit] : []);
});

function updateSelInfo() {
  const n = selection.length;
  $("#sel-info").textContent = n ? tr("{0} selected").replace("{0}", n) + (hiddenIds.size ? " · " + tr("{0} hidden").replace("{0}", hiddenIds.size) : "")
    : hiddenIds.size ? tr("{0} hidden").replace("{0}", hiddenIds.size) : "";
}
function select(objs) {
  if (objs.length && gameSel) { gameSel.userData.mesh.material = gameObjects.objects[gameSel.userData.gameIndex].type === 1 ? npcMaterial : objMaterial; gameSel = null; gizmo.showY = true; applySnap(); }
  selection = objs.filter(Boolean);
  for (const b of selectionBoxes.splice(0)) { scene.remove(b); b.geometry.dispose(); }
  for (const o of selection) {
    const b = new THREE.BoxHelper(o, o === primary() ? 0xffd400 : 0xc7a35a);
    scene.add(b);
    selectionBoxes.push(b);
  }
  placePivot();
  showProps();
  markListSelection();
  updateSelInfo();
}

function placePivot() {
  const p = primary();
  if (!p) { if (!gameSel) gizmo.detach(); return; }
  // The pivot sits on the primary (last picked) object, so grid snapping moves the group in
  // whole grid steps. With several objects the gizmo works in world axes.
  pivot.position.copy(p.position);
  if (selection.length === 1) pivot.quaternion.copy(p.quaternion);
  else pivot.quaternion.identity();
  pivot.scale.set(1, 1, 1);
  pivot.updateMatrix();
  gizmo.attach(pivot);
}

let dragStart = null;
let dragUndo = null;
gizmo.addEventListener("dragging-changed", (e) => {
  orbit.enabled = !e.value;
  if (gameSel) {
    if (!e.value) {
      const i = gameSel.userData.gameIndex;
      const x = Math.floor(gameSel.position.x / 2), y = Math.floor(gameSel.position.z / 2);
      const ob = gameObjects.objects[i];
      if (ob.x !== x || ob.y !== y) editGameObject(i, { x, y });
    }
    return;
  }
  if (e.value) {
    dragUndo = beginEdit();
    pivot.updateMatrix();
    dragStart = { pivotInv: pivot.matrix.clone().invert(), objs: selection.map((o) => { o.updateMatrix(); return [o, o.matrix.clone()]; }) };
  } else if (dragStart) {
    dragStart = null;
    if ($("#follow-ground").checked && gizmo.getMode() === "translate") {
      for (const o of selection) { o.position.y = groundHeight(o.position.x, o.position.z); writeTransform(o); }
      showProps();
    }
    followCollision(selection, dragUndo);
    placePivot();
  }
});
gizmo.addEventListener("objectChange", () => {
  if (gameSel) return;
  if (!dragStart) return;
  pivot.updateMatrix();
  const delta = pivot.matrix.clone().multiply(dragStart.pivotInv);
  for (const [o, start] of dragStart.objs) {
    delta.clone().multiply(start).decompose(o.position, o.quaternion, o.scale);
    writeTransform(o);
  }
  showProps();
  markDirty();
});

function selectionExtent() {
  const box = new THREE.Box3();
  for (const o of selection) box.expandByPoint(o.position);
  const s = box.getSize(new THREE.Vector3());
  return tr("Spread: {0} × {1} (height {2})").replace("{0}", s.x.toFixed(1)).replace("{1}", s.z.toFixed(1)).replace("{2}", s.y.toFixed(1));
}
function showProps() {
  const el = $("#props");
  if (gameSel) return showGameProps();
  if (!selection.length) {
    el.className = "empty";
    el.textContent = "Nothing selected";
    return;
  }
  el.className = "";
  const buttons = `<div class="prop-buttons"><button id="b-dup" title="Ctrl+D">Duplicate</button><button id="b-del" title="Del">Delete</button></div>` +
    `<div class="prop-buttons"><button id="b-swap" title="Put the model in the preview (tab Models) in place of the selected models; position, rotation and size stay">Replace with the preview model</button><button id="b-same" title="Select every object of this map with the same model">Select same model</button></div>` +
    `<div class="prop-buttons"><button id="b-ground" title="G: put onto the terrain height">Drop to ground</button><button id="b-rand" title="Turn at random around the vertical axis (looks natural for plants and rocks)">Random rotation</button></div>` +
    `<div class="prop-buttons"><button id="b-coll" title="Block the tiles under the object; the blocked area moves with the object">Collision under object</button></div>`;
  if (selection.length > 1) {
    el.innerHTML = `<div class="sel-count">${selection.length} objects selected</div>` +
      `<div class="prop-model">${selection.map((o) => o.userData.entity.name).slice(0, 12).join("<br>")}${selection.length > 12 ? "<br>…" : ""}</div>` +
      `<div class="prop-model">${selectionExtent()}</div>` +
      `<div class="prop-buttons"><button id="b-ax" title="Same x as the last picked object (yellow box)">Align x</button><button id="b-az" title="Same z as the last picked object (yellow box)">Align z</button><button id="b-ay" title="Same height as the last picked object (yellow box)">Align height</button></div>` +
      `<div class="prop-buttons"><button id="b-dx" title="Same distance between the objects along x (at least three objects)">Space along x</button><button id="b-dz" title="Same distance between the objects along z (at least three objects)">Space along z</button></div>` + buttons;
  } else {
    const o = primary();
    const ent = o.userData.entity;
    const md = comp(ent, "ModelDefinitionComponent");
    const pf = comp(ent, "PrefabPlacementDefinitionComponent");
    const e = new THREE.Euler().setFromQuaternion(o.quaternion, "YXZ");
    const deg = (v) => THREE.MathUtils.radToDeg(v).toFixed(1);
    const row = (label, key, vals) => `<div class="prop-row"><span>${label}</span>` +
      vals.map((v, i) => `<input type="number" step="any" data-key="${key}" data-i="${i}" value="${v}">`).join("") + "</div>";
    const what = md ? md.filename : pf ? "Prefab: " + pf.prefab : `(${o.children[0]?.userData.helper || "no model"})`;
    const linked = links[ent.id] ? `<div class="prop-model">Linked collision: ${links[ent.id].length} tile(s)</div>` : "";
    const explode = pf ? `<div class="prop-buttons"><button id="b-explode" title="Replace the prefab with its single objects so they can be edited one by one (on this map only)">Explode prefab</button></div>` : "";
    const rowBtn = `<div class="prop-buttons"><button id="b-row" title="Copies of the object in a straight line, e.g. a fence or a row of torches">Copies in a row</button></div>`;
    el.innerHTML = `<div class="prop-name">${ent.name}</div><div class="prop-model">${what}</div>` + linked + explode + rowBtn +
      row("Position", "p", [o.position.x, o.position.y, o.position.z].map((v) => v.toFixed(2))) +
      row("Rotation°", "r", [deg(e.x), deg(e.y), deg(e.z)]) +
      row("Scaling", "s", [o.scale.x, o.scale.y, o.scale.z].map((v) => v.toFixed(3))) +
      `<div class="prop-row"><span>${tr("Size (all axes)")}</span><input type="number" step="0.05" min="0.01" id="p-uniform" value="${o.scale.x.toFixed(3)}"></div>` + buttons;
    $("#p-uniform").addEventListener("change", (ev) => {
      ev.stopImmediatePropagation();
      const v = parseFloat(ev.target.value);
      if (!(v > 0)) return;
      transformSelection((x) => x.scale.setScalar(v), tr("Size {0}").replace("{0}", v));
    });
    el.querySelectorAll("input[data-key]").forEach((inp) => inp.addEventListener("change", () => {
      const entry = beginEdit();
      const v = [...el.querySelectorAll("input[data-key]")];
      const num = (k, i) => parseFloat(v.find((x) => x.dataset.key === k && x.dataset.i == i).value) || 0;
      o.position.set(num("p", 0), num("p", 1), num("p", 2));
      o.quaternion.setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(num("r", 0)), THREE.MathUtils.degToRad(num("r", 1)), THREE.MathUtils.degToRad(num("r", 2)), "YXZ"));
      o.scale.set(num("s", 0) || 1, num("s", 1) || 1, num("s", 2) || 1);
      writeTransform(o);
      markDirty();
      followCollision([o], entry);
      placePivot();
    }));
  }
  $("#b-dup").onclick = duplicate;
  $("#b-swap").onclick = replaceWithPreview;
  $("#b-same").onclick = selectSameModel;
  $("#b-ground").onclick = dropToGround;
  $("#b-rand").onclick = randomRotate;
  $("#b-coll").onclick = blockUnderSelection;
  $("#b-del").onclick = removeSelected;
  if ($("#b-explode")) $("#b-explode").onclick = explodePrefab;
  if ($("#b-row")) $("#b-row").onclick = makeRow;
  if ($("#b-ax")) {
    $("#b-ax").onclick = () => alignTo("x");
    $("#b-az").onclick = () => alignTo("z");
    $("#b-ay").onclick = () => alignTo("y");
    $("#b-dx").onclick = () => distribute("x");
    $("#b-dz").onclick = () => distribute("z");
  }
}

// ---------- undo / redo (objects and collision together) ----------
// An entry holds the entity list and the collision links as they were, plus the number of
// collision edits the server made as part of it (undone/redone through /api/collision/undo|redo).
const redoStack = [];
function snapshotState(collisionSteps = 0) {
  return { entities: doc.entities.map((e) => [e.id, JSON.stringify(e)]), links: JSON.stringify(links), collisionSteps };
}

function beginEdit() {
  if (!doc) return null;
  const entry = snapshotState();
  undoStack.push(entry);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  return entry;
}

async function restoreState(entry, direction) {
  const selIds = selection.map((o) => o.userData.entity.id);
  select([]);
  // keep objects whose entity did not change, rebuild the rest
  const current = new Map(doc.entities.map((e) => [e.id, e]));
  const next = [];
  const keep = new Set();
  for (const [id, json] of entry.entities) {
    const cur = current.get(id);
    if (cur && JSON.stringify(cur) === json) { next.push(cur); keep.add(id); }
    else next.push(JSON.parse(json));
  }
  for (const [id, obj] of [...entityObjects]) {
    if (!keep.has(id)) { root.remove(obj); entityObjects.delete(id); }
  }
  doc.entities = next;
  for (const ent of next) if (!keep.has(ent.id)) await addObjectFor(ent);
  for (let i = 0; i < entry.collisionSteps; i++) {
    const r = await postJSON(`collision/${direction}`, { path: presetPath });
    if (r.ok) showCollision(r.data);
  }
  if (entry.collisionSteps) { gameSel = null; await loadGameObjects(); }
  if (entry.links !== JSON.stringify(links)) {
    links = JSON.parse(entry.links);
    await postJSON("links", { path: presetPath }, links);
  }
  select(selIds.map((id) => entityObjects.get(id)));
  markDirty();
}

function updateUndoButtons() {
  $("#btn-undo").disabled = !undoStack.length;
  $("#btn-redo").disabled = !redoStack.length;
  $("#btn-undo").title = tr("Ctrl+Z · {0} step(s)").replace("{0}", undoStack.length);
  $("#btn-redo").title = tr("Ctrl+Y · {0} step(s)").replace("{0}", redoStack.length);
}
async function undo() {
  const entry = undoStack.pop();
  if (!entry) return setStatus("Nothing to undo");
  redoStack.push(snapshotState(entry.collisionSteps));
  await restoreState(entry, "undo");
  setStatus("Undone");
}

async function redo() {
  const entry = redoStack.pop();
  if (!entry) return setStatus("Nothing to redo");
  undoStack.push(snapshotState(entry.collisionSteps));
  await restoreState(entry, "redo");
  setStatus("Redone");
}

// ---------- editing ----------
function newId() {
  const ids = new Set(doc.entities.map((e) => e.id));
  let id;
  do { id = Math.floor(Math.random() * 0x7fffffff); } while (ids.has(id));
  return id;
}

function addDependency(modelPath) {
  doc.dependencies = doc.dependencies || {};
  const list = (doc.dependencies.models = doc.dependencies.models || []);
  if (!list.some((m) => m.path.toLowerCase() === modelPath.toLowerCase())) list.push({ path: modelPath });
}

async function placeModel(modelPath, at = null) {
  if (!doc) return alert("Open a map first.");
  beginEdit();
  const base = modelPath.split("/").pop().replace(/\.model$/, "");
  const name = `${base}_${Date.now() % 100000}`;
  const tgt = at || orbit.target;
  const ent = {
    type: "Entity", name, id: newId(), components: [
      { type: "TransformDefinitionComponent", name: `${name}_TransformDefinitionComponent`,
        position: { x: Math.round(tgt.x * 2) / 2, y: 0, z: Math.round(tgt.z * 2) / 2 },
        orientation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, inheritOnlyPosition: false },
      { type: "ModelPlatformTierComponent", name: `${name}_ModelPlatformTierComponent`, visibilityTier: 0, shadowTier: 0 },
      { type: "ModelDefinitionComponent", name: `${name}_ModelDefinitionComponent`, filename: modelPath,
        visibleLayers: 1, lightMask: 19, shadowMask: 3, ghostShadows: false, floorModel: false,
        terrainBlendEnableYUpBlend: false, terrainBlendMode: 1 },
    ],
  };
  addDependency(modelPath);
  rememberModel(modelPath);
  doc.entities.push(ent);
  select([await addObjectFor(ent)]);
  markDirty();
  setStatus(`${base} placed`);
}

async function duplicate() {
  if (!selection.length) return;
  beginEdit();
  const copies = [];
  for (const o of selection) {
    const src = o.userData.entity;
    const ent = JSON.parse(JSON.stringify(src));
    ent.id = newId();
    ent.name = `${src.name}_copy`;
    const t = comp(ent, "TransformDefinitionComponent");
    if (t) { t.position.x += 2; t.position.z += 2; }
    doc.entities.push(ent);
    copies.push(await addObjectFor(ent));
  }
  select(copies);
  markDirty();
}

async function removeSelected() {
  if (!selection.length) return;
  const entry = beginEdit();
  const gone = selection.map((o) => o.userData.entity);
  const goneSet = new Set(gone);
  doc.entities = doc.entities.filter((e) => !goneSet.has(e));
  for (const o of selection) { root.remove(o); entityObjects.delete(o.userData.entity.id); }
  // remove the collision that was linked to deleted objects
  const ops = [];
  for (const ent of gone) {
    if (!links[ent.id]) continue;
    for (const [tx, ty] of unlinkTiles(ent.id)) ops.push({ tx, ty, mode: "reset" });
  }
  select([]);
  markDirty();
  if (ops.length) {
    await sendCollisionOps(ops, entry);
    await postJSON("links", { path: presetPath }, links);
  }
  setStatus(`${gone.length} object(s) deleted`);
}

async function save() {
  if (!doc) return;
  const r = await postJSON("preset", { path: presetPath }, doc);
  if (r.ok) {
    dirty = false;
    updateSceneInfo();
    setStatus("Saved: " + r.data.saved);
    const li = document.querySelector(`#preset-list li[data-path="${presetPath}"]`);
    if (li) li.classList.add("edited");
    editedMaps.add(presetPath);
  } else setStatus(`Error while saving: ${r.data.error}`);
}

// ---------- collision (legacy DS1 grid, 1 tile = 10 units, 1 subtile = 2 units) ----------
let tool = "objects";
let coll = null;          // server payload
let collMesh = null;

function collisionTexture(c) {
  const [w, h] = c.subtiles;
  const cells = Uint8Array.from(atob(c.grid), (ch) => ch.charCodeAt(0));
  const edited = new Set(c.edited.map(([x, y]) => `${x},${y}`));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = cells[y * w + x];
      const i = (y * w + x) * 4;
      const ed = edited.has(`${Math.floor(x / 5)},${Math.floor(y / 5)}`);
      const border = ed && (x % 5 === 0 || y % 5 === 0 || x % 5 === 4 || y % 5 === 4);
      if (border) data.set([255, 220, 0, 200], i);
      else if (f & 1) data.set([220, 30, 30, 120], i);
      else if (f & 2) data.set([40, 90, 230, 90], i);
      else data.set([0, 0, 0, 0], i);
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

function showCollision(c) {
  coll = c;
  if (collMesh) { scene.remove(collMesh); collMesh.geometry.dispose(); collMesh.material.map.dispose(); collMesh = null; }
  if (!c) return;
  const W = c.width * 10, H = c.height * 10;
  const geo = new THREE.PlaneGeometry(W, H);
  // PlaneGeometry: uv v=0 at -y. rotateX(+90deg) maps -y to world -z, so grid row 0 (DS1 y = 0)
  // lands at world z = 0 after the translation.
  geo.rotateX(Math.PI / 2);
  geo.translate(W / 2, 0.15, H / 2);
  const mat = new THREE.MeshBasicMaterial({ map: collisionTexture(c), transparent: true, depthWrite: false, side: THREE.DoubleSide });
  collMesh = new THREE.Mesh(geo, mat);
  collMesh.renderOrder = 10;
  collMesh.visible = $("#show-coll").checked;
  collMesh.raycast = () => {}; // never steals object selection
  scene.add(collMesh);
}

async function loadCollision() {
  showCollision(null);
  try {
    const res = await fetch(api("collision", { path: presetPath }));
    if (res.ok) showCollision(await res.json());
  } catch { /* preset without ds1 */ }
}

async function sendCollisionOps(ops, entry) {
  if (!ops.length || !presetPath) return;
  const r = await postJSON("collision", { path: presetPath }, { ops });
  if (r.ok) {
    if (entry) entry.collisionSteps += 1;
    showCollision(r.data);
    setStatus(`Collision saved (${ops.length} tile(s)) in ${r.data.ds1}`);
  } else setStatus(`Collision: ${r.data.error}`);
}

function tilesUnder(obj) {
  const b = new THREE.Box3().setFromObject(obj);
  const out = [];
  if (b.isEmpty() || !coll) return out;
  for (let tx = Math.floor(b.min.x / 10); tx <= Math.floor(b.max.x / 10); tx++)
    for (let ty = Math.floor(b.min.z / 10); ty <= Math.floor(b.max.z / 10); ty++)
      if (tx >= 0 && ty >= 0 && tx < coll.width && ty < coll.height) out.push([tx, ty]);
  return out;
}

// Tiles of a link that no other linked object still uses; removes the link.
function unlinkTiles(id) {
  const mine = links[id] || [];
  delete links[id];
  const used = new Set(Object.values(links).flat().map(([x, y]) => `${x},${y}`));
  return mine.filter(([x, y]) => !used.has(`${x},${y}`));
}

async function blockUnderSelection() {
  if (!selection.length || !coll) return;
  const entry = beginEdit();
  const ops = [];
  // Tiles you already edited by hand stay yours: the link only owns tiles it blocks itself,
  // so moving the object later never frees a hand-painted tile.
  const handEdited = handEditedTiles();
  for (const o of selection) {
    const tiles = tilesUnder(o).filter(([x, y]) => !handEdited.has(`${x},${y}`));
    links[o.userData.entity.id] = tiles;
    for (const [tx, ty] of tiles) ops.push({ tx, ty, mode: "block" });
  }
  if (!ops.length) { undoStack.pop(); return setStatus("These tiles are already blocked"); }
  if (!$("#show-coll").checked) { $("#show-coll").checked = true; if (collMesh) collMesh.visible = true; }
  await sendCollisionOps(ops, entry);
  await postJSON("links", { path: presetPath }, links);
  showProps();
}

// After objects moved: move the collision linked to them along.
function handEditedTiles() {
  // tiles changed by hand (not owned by any link): a link never takes them over
  const hand = new Set(coll ? coll.edited.map(([x, y]) => `${x},${y}`) : []);
  for (const id of Object.keys(links)) for (const [x, y] of links[id]) hand.delete(`${x},${y}`);
  return hand;
}

async function followCollision(objs, entry) {
  const ops = [];
  const hand = handEditedTiles();
  for (const o of objs) {
    const id = o.userData.entity.id;
    if (!links[id]) continue;
    const old = links[id];
    const now = tilesUnder(o).filter(([x, y]) => !hand.has(`${x},${y}`));
    const key = (t) => `${t[0]},${t[1]}`;
    if (old.map(key).sort().join() === now.map(key).sort().join()) continue;
    for (const t of unlinkTiles(id)) if (!now.some((n) => key(n) === key(t))) ops.push({ tx: t[0], ty: t[1], mode: "reset" });
    links[id] = now;
    for (const [tx, ty] of now) ops.push({ tx, ty, mode: "block" });
  }
  if (!ops.length) return;
  await sendCollisionOps(ops, entry);
  await postJSON("links", { path: presetPath }, links);
  showProps();
}

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function tileAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(p, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(groundPlane, hit) || !coll) return null;
  // tile tools paint 10x10 unit tiles, subtile tools 2x2 unit subtiles (5 per tile)
  const unit = cellSize(), per = 10 / unit;
  const tx = Math.floor(hit.x / unit), ty = Math.floor(hit.z / unit);
  return tx >= 0 && ty >= 0 && tx < coll.width * per && ty < coll.height * per ? [tx, ty] : null;
}
const cellSize = () => (tool.startsWith("sub_") ? 2 : 10);

let painting = null;
// cells painted in the current stroke, shown at once (the server answers on release)
const strokeMat = new THREE.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: 0.35, depthWrite: false });
const strokeGroup = new THREE.Group();
scene.add(strokeGroup);
function strokeCells(t) {
  const size = +$("#brush").value || 1, half = (size - 1) / 2, unit = cellSize();
  for (let dx = -half; dx <= half; dx++)
    for (let dy = -half; dy <= half; dy++) {
      const key = `${t[0] + dx},${t[1] + dy}`;
      if (strokeGroup.getObjectByName(key)) continue;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(unit, unit).rotateX(-Math.PI / 2), strokeMat);
      m.name = key;
      m.position.set((t[0] + dx) * unit + unit / 2, 0.3, (t[1] + dy) * unit + unit / 2);
      strokeGroup.add(m);
    }
}
function clearStroke() {
  for (const m of [...strokeGroup.children]) { strokeGroup.remove(m); m.geometry.dispose(); }
}
function setTool(t) {
  $("#tool").value = t;
  $("#tool").dispatchEvent(new Event("change"));
  setStatus(tr("Tool: {0}").replace("{0}", $("#tool").selectedOptions[0].textContent));
}
function setBrush(step) {
  const sel = $("#brush"), i = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + step));
  sel.selectedIndex = i;
  setStatus(tr("Brush {0}").replace("{0}", sel.options[i].textContent));
}
const brush = new THREE.Mesh(new THREE.BoxGeometry(10, 0.4, 10), new THREE.MeshBasicMaterial({ color: 0xffd400, wireframe: true }));
brush.visible = false;
scene.add(brush);
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (tool === "objects" || e.button !== 0) return;
  painting = new Map();
  const t = tileAt(e);
  if (t) { painting.set(t.join(","), t); strokeCells(t); }
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (tool === "objects") { brush.visible = false; return; }
  const t = tileAt(e);
  brush.visible = !!t;
  if (t) {
    const size = +$("#brush").value || 1;
    const unit = cellSize();
    brush.scale.set(size * unit / 10, 1, size * unit / 10);
    brush.position.set(t[0] * unit + unit / 2, 0.2, t[1] * unit + unit / 2);
  }
  if (painting && t && !painting.has(t.join(","))) { painting.set(t.join(","), t); strokeCells(t); }
});
window.addEventListener("pointerup", () => {
  if (!painting) return;
  const size = +$("#brush").value || 1, half = (size - 1) / 2;
  const cells = new Map();
  for (const [tx, ty] of painting.values())
    for (let dx = -half; dx <= half; dx++)
      for (let dy = -half; dy <= half; dy++) {
        const x = tx + dx, y = ty + dy, per = 10 / cellSize();
        if (coll && x >= 0 && y >= 0 && x < coll.width * per && y < coll.height * per) cells.set(`${x},${y}`, [x, y]);
      }
  const ops = [...cells.values()].map(([x, y]) => (tool.startsWith("sub_") ? { sx: x, sy: y, mode: tool } : { tx: x, ty: y, mode: tool }));
  painting = null;
  if (ops.length) sendCollisionOps(ops, beginEdit()).finally(clearStroke);
  else clearStroke();
});

$("#show-coll").addEventListener("change", (e) => { if (collMesh) collMesh.visible = e.target.checked; });
$("#tool").addEventListener("change", (e) => {
  tool = e.target.value;
  $("#brush").classList.toggle("hidden", tool === "objects");
  if (tool !== "objects") {
    select([]);
    $("#show-coll").checked = true;
    if (collMesh) collMesh.visible = true;
  }
  brush.visible = false;
});
$("#show-helpers").addEventListener("change", (e) => {
  showHelpers = e.target.checked;
  if (root) root.traverse((o) => { if (o.userData.helper) o.visible = showHelpers; });
});

// ---------- model preview ----------
const previewCanvas = $("#preview");
const previewRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true });
previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
const previewScene = new THREE.Scene();
previewScene.background = new THREE.Color(0x0c0b09);
previewScene.add(new THREE.HemisphereLight(0xfff4dd, 0x2a2418, 1.8));
const previewSun = new THREE.DirectionalLight(0xffffff, 2);
previewSun.position.set(-1, 2, 1.5);
previewScene.add(previewSun);
const previewCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 2000);
let previewObj = null;
let previewToken = 0;
async function showPreview(path) {
  const token = ++previewToken;
  $("#preview-info").textContent = `Loading ${path.replace("data/hd/", "")} …`;
  updateFavButton();
  const m = await loadModel(path);
  if (token !== previewToken) return;
  if (previewObj) previewScene.remove(previewObj);
  if (!m) { $("#preview-info").textContent = "Could not load the model"; return; }
  previewObj = new THREE.Group();
  const inner = m.clone(true);
  previewObj.add(inner);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  inner.position.sub(box.getCenter(new THREE.Vector3()));
  previewScene.add(previewObj);
  const r = Math.max(size.x, size.y, size.z) || 1;
  previewCamera.position.set(0, r * 0.6, r * 1.9).multiplyScalar(previewZoom);
  previewCamera.lookAt(0, 0, 0);
  $("#preview-info").textContent = `${path.replace("data/hd/", "")} · ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)}`;
}
// drag the preview to turn the model, wheel to zoom; it turns by itself again after 3 s
let previewDrag = null, previewTouched = 0, previewZoom = 1;
previewCanvas.addEventListener("pointerdown", (e) => { previewDrag = { x: e.clientX, y: e.clientY }; previewCanvas.setPointerCapture(e.pointerId); });
previewCanvas.addEventListener("pointermove", (e) => {
  if (!previewDrag || !previewObj) return;
  previewObj.rotation.y += (e.clientX - previewDrag.x) * 0.01;
  previewObj.rotation.x = Math.max(-1.2, Math.min(1.2, previewObj.rotation.x + (e.clientY - previewDrag.y) * 0.01));
  previewDrag = { x: e.clientX, y: e.clientY };
  previewTouched = performance.now();
});
previewCanvas.addEventListener("pointerup", () => { previewDrag = null; previewTouched = performance.now(); });
previewCanvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
  previewZoom = Math.max(0.3, Math.min(4, previewZoom * f));
  previewCamera.position.multiplyScalar(f);
  previewTouched = performance.now();
}, { passive: false });
function renderPreview() {
  const w = previewCanvas.clientWidth, h = previewCanvas.clientHeight;
  if (w && (previewCanvas.width !== w || previewCanvas.height !== h)) {
    previewRenderer.setSize(w, h, false);
    previewCamera.aspect = w / h;
    previewCamera.updateProjectionMatrix();
  }
  if (previewObj && !previewDrag && performance.now() - previewTouched > 3000) previewObj.rotation.y += 0.01;
  if (w) previewRenderer.render(previewScene, previewCamera);
  requestAnimationFrame(renderPreview);
}
renderPreview();

// ---------- in-game test ----------
function modalShow(title, text) {
  $("#modal-title").textContent = title;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  $("#modal-body").innerHTML = text.split("\n").map((l) =>
    l.startsWith("PASS") ? `<span class="pass">${esc(l)}</span>` : l.startsWith("FAIL") ? `<span class="fail">${esc(l)}</span>` : esc(l)).join("\n");
  $("#modal").classList.remove("hidden");
}
$("#modal-close").onclick = () => $("#modal").classList.add("hidden");
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").classList.add("hidden"); });

function askModName() {
  const name = prompt("Mod name (folder under mods\\):", localStorage.getItem("modName") || "D2REditor");
  if (name) localStorage.setItem("modName", name);
  return name;
}

async function startTest() {
  if (dirty && !confirm("The current map has unsaved changes. Save first?")) return;
  if (dirty) await save();
  const name = askModName();
  if (!name) return;
  const r = await postJSON("test", { name });
  if (!r.ok) return setStatus("Test: " + r.data.error);
  const banner = $("#banner");
  banner.classList.remove("hidden");
  const poll = async () => {
    const s = await (await fetch(api("test"))).json();
    if (s.running) {
      banner.textContent = `In-game test running (second monitor, muted) … ${Math.round(s.elapsed)} s`;
      setTimeout(poll, 2000);
    } else {
      banner.classList.add("hidden");
      const failed = /^FAIL/m.test(s.report) || !/^PASS/m.test(s.report);
      setStatus(failed ? "In-game test: problems found" : "In-game test: all passed");
      modalShow(`In-game test – mod ${s.mod}`, s.report || "(no report)");
    }
  };
  poll();
}

// ---------- prefab explode ----------
// A prefab placement references a shared JSON (used on many maps). Exploding replaces the placement
// with copies of its entities in world space, so they can be edited one by one on this map only.
async function explodePrefab() {
  const o = primary();
  const ent = o && o.userData.entity;
  const pf = ent && comp(ent, "PrefabPlacementDefinitionComponent");
  if (!pf) return;
  const sub = await (await fetch(api("preset", { path: pf.prefab }))).json();
  beginEdit();
  o.updateMatrix();
  const parent = o.matrix.clone();
  const created = [];
  for (const child of sub.entities || []) {
    const e = JSON.parse(JSON.stringify(child));
    e.id = newId();
    e.name = `${ent.name}__${child.name}`;
    const t = comp(e, "TransformDefinitionComponent");
    if (t) {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(t.position.x, t.position.y, t.position.z),
        new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w),
        new THREE.Vector3(t.scale.x, t.scale.y, t.scale.z));
      const w = parent.clone().multiply(m);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      w.decompose(p, q, sc);
      const r = (v) => Math.round(v * 1e6) / 1e6;
      t.position = { x: r(p.x), y: r(p.y), z: r(p.z) };
      t.orientation = { x: r(q.x), y: r(q.y), z: r(q.z), w: r(q.w) };
      t.scale = { x: r(sc.x), y: r(sc.y), z: r(sc.z) };
    }
    const md = comp(e, "ModelDefinitionComponent");
    if (md && md.filename) addDependency(md.filename);
    doc.entities.push(e);
    created.push(await addObjectFor(e));
  }
  // carry over the prefab's other dependencies (particles, sounds, ...)
  for (const [kind, list] of Object.entries(sub.dependencies || {})) {
    const target = (doc.dependencies = doc.dependencies || {})[kind] = (doc.dependencies[kind] || []);
    for (const d of list || []) if (d.path && !target.some((x) => (x.path || "").toLowerCase() === d.path.toLowerCase())) target.push(d);
  }
  doc.entities = doc.entities.filter((e) => e !== ent);
  root.remove(o);
  entityObjects.delete(ent.id);
  if (links[ent.id]) {  // the placement is gone: its collision link would point at nothing
    delete links[ent.id];
    await postJSON("links", { path: presetPath }, links);
  }
  select(created);
  markDirty();
  setStatus(`Prefab exploded: ${created.length} objects`);
}

// ---------- object list ----------
function kindOf(ent) {
  if (comp(ent, "TerrainDefinitionComponent")) return ["⛰", "Terrain"];
  if (comp(ent, "PrefabPlacementDefinitionComponent")) return ["▣", "Prefab"];
  if (comp(ent, "ModelDefinitionComponent")) return ["■", "Model"];
  const k = HELPER_KINDS.find(([t]) => comp(ent, t));
  return ["◆", k ? k[2] : "Other"];
}
let listTimer = null;
function scheduleObjectList() {
  clearTimeout(listTimer);
  listTimer = setTimeout(renderObjectList, 300);
}
function renderObjectList() {
  if (!doc) return;
  const f = $("#object-filter").value.toLowerCase();
  const ul = $("#object-list");
  ul.innerHTML = "";
  let shown = 0;
  for (const ent of doc.entities) {
    const [icon, kind] = kindOf(ent);
    // the kind can be searched in the shown language too (e.g. "Licht" for lights)
    if (f && !ent.name.toLowerCase().includes(f) && !kind.toLowerCase().includes(f) && !tr(kind).toLowerCase().includes(f)) continue;
    if (shown >= 1500) { shown += 1; continue; }  // the list shows 1500 entries, the count stays right
    shown += 1;
    const li = document.createElement("li");
    li.innerHTML = `<span class="kind" title="${kind}">${icon}</span>`;
    li.appendChild(document.createTextNode(ent.name));
    li.dataset.id = ent.id;
    if (hiddenIds.has(ent.id)) li.classList.add("hidden-obj");
    li.onclick = (e) => {
      const o = entityObjects.get(ent.id);
      if (!o || o.userData.terrain) return;
      if (e.shiftKey) select(selection.includes(o) ? selection.filter((x) => x !== o) : [...selection, o]);
      else { select([o]); orbit.target.copy(o.position); }
    };
    li.ondblclick = () => {
      const o = entityObjects.get(ent.id);
      if (!o || o.userData.terrain) return;
      // move the camera close to the object, keeping the view direction
      const dir = camera.position.clone().sub(orbit.target).normalize();
      const r = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()).length() || 10;
      orbit.target.copy(o.position);
      camera.position.copy(o.position).addScaledVector(dir, Math.max(15, r * 2));
      orbit.update();
    };
    ul.appendChild(li);
  }
  $("#object-count").textContent = f ? `${doc.entities.length} objects, ${shown} matching` : `${doc.entities.length} objects`;
  markListSelection();
}
function markListSelection() {
  const ids = new Set(selection.map((o) => String(o.userData.entity.id)));
  let first = null;
  document.querySelectorAll("#object-list li").forEach((li) => {
    const on = ids.has(li.dataset.id);
    li.classList.toggle("sel", on);
    if (on && !first) first = li;
  });
  if (first && !$("#pane-objects").classList.contains("hidden")) first.scrollIntoView({ block: "nearest" });
}
$("#object-filter").addEventListener("input", scheduleObjectList);
$("#object-select-all").addEventListener("click", () => {
  const ids = [...document.querySelectorAll("#object-list li")].map((li) => +li.dataset.id);
  const objs = ids.map((id) => entityObjects.get(id)).filter((o) => o && o.visible && !o.userData.terrain);
  select(objs);
  setStatus(tr("{0} object(s) selected").replace("{0}", objs.length));
});

// ---------- place at the mouse cursor ----------
let cursorGround = null;
let previewPath = null;
renderer.domElement.addEventListener("pointermove", (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(p, camera);
  const hit = new THREE.Vector3();
  cursorGround = raycaster.ray.intersectPlane(groundPlane, hit) ? hit : null;
});

// ---------- how the game uses this map piece ----------
async function showPresetInfo(path) {
  const banner = $("#banner");
  banner.className = "hidden";
  try {
    const info = await (await fetch(api("presetinfo", { path }))).json();
    if (!info.known) return;
    const levels = [...new Set(info.rows.filter((r) => r.levelId).map((r) => r.level))];
    if (info.shared) {
      banner.className = "warn";
      banner.innerHTML = `<span class="close" title="Hide">✕</span>Note: this map piece is a reusable building block ` +
        `(${info.rows.map((r) => r.name).join(", ")}). Random areas can place it several times – changes show up at every one of those places.`;
    } else {
      const variants = Math.max(...info.rows.map((r) => r.variants));
      banner.className = "info";
      banner.innerHTML = `<span class="close" title="Hide">✕</span>Own map piece of: ${levels.join(", ") || "-"}` +
        (variants > 1 ? ` – one of ${variants} variants; the game picks one by seed (always the same with a fixed seed).` : ".");
    }
    banner.querySelector(".close").onclick = () => banner.classList.add("hidden");
  } catch { /* info is optional */ }
}

// ---------- DS1 game objects (NPCs, monster spawns, chests, waypoints...) ----------
// They live in the legacy DS1 (positions in subtiles: world = subtile * 2) and are what the game
// actually places. Edited through /api/objects; undo shares the DS1 history with collision.
let gameObjects = null;    // server payload {editable, act, objects, catalog}
let gameRoot = new THREE.Group();
scene.add(gameRoot);
let gameSel = null;        // selected marker
const npcGeometry = new THREE.ConeGeometry(1.3, 4, 8).translate(0, 2, 0);
const objGeometry = new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0);
const npcMaterial = new THREE.MeshBasicMaterial({ color: 0xff5a3c, wireframe: true });
const objMaterial = new THREE.MeshBasicMaterial({ color: 0x3cd6c8, wireframe: true });
const selMaterial = new THREE.MeshBasicMaterial({ color: 0xffd400, wireframe: true });

function textSprite(text, color) {
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d");
  ctx.font = "bold 28px system-ui";
  cv.width = Math.ceil(ctx.measureText(text).width) + 16;
  cv.height = 40;
  ctx.font = "bold 28px system-ui";
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = color;
  ctx.fillText(text, 8, 29);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
  sp.scale.set(cv.width / 16, cv.height / 16, 1);
  sp.renderOrder = 20;
  return sp;
}

function buildGameObjects() {
  scene.remove(gameRoot);
  gameRoot = new THREE.Group();
  gameRoot.visible = $("#show-objs").checked;
  scene.add(gameRoot);
  if (!gameObjects) return;
  gameObjects.objects.forEach((ob, i) => {
    const g = new THREE.Group();
    g.position.set(ob.x * 2 + 1, groundHeight(ob.x * 2 + 1, ob.y * 2 + 1), ob.y * 2 + 1);
    const m = new THREE.Mesh(ob.type === 1 ? npcGeometry : objGeometry, ob.type === 1 ? npcMaterial : objMaterial);
    g.add(m);
    const label = textSprite(ob.name, ob.type === 1 ? "#ff9a80" : "#8ff0e6");
    label.position.y = ob.type === 1 ? 6 : 4;
    g.add(label);
    g.userData.gameIndex = i;
    g.userData.mesh = m;
    if (ob.path && ob.path.length) {
      const pts = [new THREE.Vector3(0, 0.3, 0)].concat(ob.path.map(([x, y]) => new THREE.Vector3(x * 2 + 1 - g.position.x, 0.3, y * 2 + 1 - g.position.z)));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xff9a80 })));
    }
    gameRoot.add(g);
  });
}

async function loadGameObjects() {
  gameObjects = null;
  try {
    const res = await fetch(api("objects", { path: presetPath }));
    if (res.ok) gameObjects = await res.json();
  } catch { /* no ds1 */ }
  buildGameObjects();
  fillAddObjectList();
}

function selectGameObject(g) {
  select([]);
  if (gameSel) gameSel.userData.mesh.material = gameObjects.objects[gameSel.userData.gameIndex].type === 1 ? npcMaterial : objMaterial;
  gameSel = g;
  if (g) {
    g.userData.mesh.material = selMaterial;
    gizmo.attach(g);
    gizmo.setMode("translate");
    gizmo.showY = false;
    gizmo.setTranslationSnap(2);
  } else {
    gizmo.showY = true;
    applySnap();
  }
  showGameProps();
}

function showGameProps() {
  if (!gameSel) return;
  const ob = gameObjects.objects[gameSel.userData.gameIndex];
  const list = ob.type === 1 ? gameObjects.catalog.npc : gameObjects.catalog.obj;
  const el = $("#props");
  el.className = "";
  el.innerHTML = `<div class="prop-name">${ob.name}</div><div class="prop-model">Game object (DS1) · ${ob.type === 1 ? "NPC / monster" : "Object"} · ID ${ob.id}` +
    `${ob.path && ob.path.length ? ` · path with ${ob.path.length} points` : ""}</div>` +
    `<div class="prop-row"><span>Type</span><select id="go-id">${list.map((e) => `<option value="${e.id}"${e.id === ob.id ? " selected" : ""}>${e.id}: ${e.name}</option>`).join("")}</select></div>` +
    `<div class="prop-row"><span>Subtile</span><input id="go-x" type="number" value="${ob.x}"><input id="go-y" type="number" value="${ob.y}"><span></span></div>` +
    `<div class="prop-buttons"><button id="go-del">Delete</button></div>` +
    (gameObjects.editable ? "" : `<div class="prop-model">This DS1 does not allow object changes.</div>`);
  $("#go-id").onchange = () => editGameObject(gameSel.userData.gameIndex, { id: +$("#go-id").value });
  $("#go-x").onchange = $("#go-y").onchange = () => editGameObject(gameSel.userData.gameIndex, { x: +$("#go-x").value, y: +$("#go-y").value });
  $("#go-del").onclick = () => deleteGameObject(gameSel.userData.gameIndex);
}

async function sendGameObjects(objects, entry) {
  const r = await postJSON("objects", { path: presetPath }, { objects });
  if (!r.ok) { setStatus(`Game objects: ${r.data.error}`); return false; }
  if (entry) entry.collisionSteps += 1; // same DS1 history as collision
  const keep = gameSel ? gameSel.userData.gameIndex : null;
  gameObjects = r.data;
  buildGameObjects();
  gameSel = null;
  if (keep !== null && keep < gameObjects.objects.length) selectGameObject(gameRoot.children[keep]);
  else selectGameObject(null);
  loadCollision(); // the DS1 override changed; keep the overlay in sync
  setStatus("Game objects saved");
  return true;
}

function currentObjects() {
  return gameObjects.objects.map(({ type, id, x, y, flags }) => ({ type, id, x, y, flags, from: [x, y] }));
}

async function editGameObject(i, change) {
  const objs = currentObjects();
  Object.assign(objs[i], change);
  await sendGameObjects(objs, beginEdit());
}

async function deleteGameObject(i) {
  const objs = currentObjects();
  objs.splice(i, 1);
  gameSel = null;
  await sendGameObjects(objs, beginEdit());
  select([]);
}

async function addGameObject(at) {
  if (!gameObjects || !gameObjects.editable) return setStatus("This map has no editable game objects");
  const p = at || orbit.target;
  const objs = currentObjects();
  objs.push({ type: +$("#add-obj-type").value, id: +$("#add-obj-id").value, x: Math.floor(p.x / 2), y: Math.floor(p.z / 2), flags: 0 });
  gameSel = null;
  if (await sendGameObjects(objs, beginEdit())) selectGameObject(gameRoot.children[gameRoot.children.length - 1]);
}

function fillAddObjectList() {
  const sel = $("#add-obj-id");
  if (!gameObjects) { sel.innerHTML = ""; return; }
  const all = +$("#add-obj-type").value === 1 ? gameObjects.catalog.npc : gameObjects.catalog.obj;
  const f = $("#add-obj-filter").value.trim().toLowerCase();
  const keep = sel.value;
  const list = f ? all.filter((e) => `${e.id}: ${e.name}`.toLowerCase().includes(f)) : all;
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  sel.innerHTML = list.map((e) => `<option value="${e.id}">${e.id}: ${esc(e.name)}</option>`).join("");
  if (list.some((e) => String(e.id) === keep)) sel.value = keep;
  $("#add-obj-btn").disabled = !list.length;
}
$("#add-obj-filter").addEventListener("input", fillAddObjectList);
$("#add-obj-type").addEventListener("change", fillAddObjectList);
$("#add-obj-btn").addEventListener("click", () => addGameObject(null));
$("#show-objs").addEventListener("change", (e) => { gameRoot.visible = e.target.checked; if (!e.target.checked) selectGameObject(null); });

// ---------- transform helpers for the selection ----------
async function transformSelection(fn, label) {
  if (!selection.length) return;
  const entry = beginEdit();
  for (const o of selection) { fn(o); writeTransform(o); }
  markDirty();
  await followCollision(selection, entry);
  placePivot();
  showProps();
  if (label) setStatus(label);
}

const downRay = new THREE.Raycaster();
function groundHeight(x, z) {
  const terrains = [];
  root.traverse((o) => { if (o.userData.terrain) terrains.push(o); });
  downRay.set(new THREE.Vector3(x, 1000, z), new THREE.Vector3(0, -1, 0));
  const hit = downRay.intersectObjects(terrains, true)[0];
  return hit ? hit.point.y : 0;
}
function dropToGround() {
  return transformSelection((o) => { o.position.y = groundHeight(o.position.x, o.position.z); },
    `${selection.length} object(s) dropped to the ground`);
}
function randomRotate() {
  return transformSelection((o) => {
    o.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2));
  }, "Rotated at random");
}
function nudge(dx, dy, dz) {
  return transformSelection((o) => { o.position.x += dx; o.position.y += dy; o.position.z += dz; });
}

// ---------- copy / paste (also between maps, through localStorage) ----------
function copySelection() {
  if (!selection.length) return;
  const anchor = primary().position;
  const items = selection.map((o) => o.userData.entity);
  localStorage.setItem("d2r-clipboard", JSON.stringify({ anchor: [anchor.x, anchor.y, anchor.z], items }));
  setStatus(`${items.length} object(s) copied`);
}
async function paste() {
  const clip = JSON.parse(localStorage.getItem("d2r-clipboard") || "null");
  if (!clip || !doc) return setStatus("The clipboard is empty");
  beginEdit();
  const target = cursorGround ? cursorGround.clone() : orbit.target.clone();
  const step = +$("#snap-t").value || 0.5;
  const snap = (v) => ($("#snap").checked ? Math.round(v / step) * step : v);
  // snap the common offset only, so the copied group keeps its exact layout
  const dx = snap(target.x - clip.anchor[0]), dz = snap(target.z - clip.anchor[2]);
  const created = [];
  for (const src of clip.items) {
    const ent = JSON.parse(JSON.stringify(src));
    ent.id = newId();
    ent.name = `${src.name}_copy`;
    const t = comp(ent, "TransformDefinitionComponent");
    if (t) {
      t.position.x += dx;
      t.position.z += dz;
    }
    const md = comp(ent, "ModelDefinitionComponent");
    if (md && md.filename) addDependency(md.filename);
    doc.entities.push(ent);
    created.push(await addObjectFor(ent));
  }
  select(created);
  markDirty();
  setStatus(`${created.length} object(s) pasted`);
}

// ---------- marquee (rectangle) selection with the left mouse button ----------
let marquee = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (tool !== "objects" || e.button !== 0 || gizmo.axis) return;
  marquee = { x: e.clientX, y: e.clientY, active: false, add: e.shiftKey };
});
window.addEventListener("pointermove", (e) => {
  if (!marquee) return;
  const w = e.clientX - marquee.x, h = e.clientY - marquee.y;
  if (!marquee.active && Math.hypot(w, h) < 6) return;
  marquee.active = true;
  const el = $("#marquee");
  el.classList.remove("hidden");
  Object.assign(el.style, { left: `${Math.min(e.clientX, marquee.x)}px`, top: `${Math.min(e.clientY, marquee.y)}px`,
    width: `${Math.abs(w)}px`, height: `${Math.abs(h)}px` });
  marquee.end = [e.clientX, e.clientY];
});
window.addEventListener("pointerup", () => {
  const m = marquee;
  if (!m) return;
  $("#marquee").classList.add("hidden");
  if (!m.active) { marquee = null; return; }
  const r = renderer.domElement.getBoundingClientRect();
  const x0 = Math.min(m.x, m.end[0]), x1 = Math.max(m.x, m.end[0]);
  const y0 = Math.min(m.y, m.end[1]), y1 = Math.max(m.y, m.end[1]);
  const v = new THREE.Vector3();
  const hits = [];
  for (const o of entityObjects.values()) {
    if (o.userData.terrain || !o.visible) continue;
    if (!showHelpers && o.children[0] && o.children[0].userData.helper) continue;
    v.copy(o.position).project(camera);
    if (v.z > 1) continue;
    const sx = r.left + ((v.x + 1) / 2) * r.width, sy = r.top + ((1 - v.y) / 2) * r.height;
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) hits.push(o);
  }
  select(m.add ? [...new Set([...selection, ...hits])] : hits);
  setStatus(`${hits.length} object(s) in the box`);
  setTimeout(() => { marquee = null; }, 0); // let the click handler see that a rectangle was drawn
});

// ---------- top view ----------
let savedView = null;
function toggleTopView() {
  if (savedView) {
    camera.position.copy(savedView);
    savedView = null;
    $("#btn-top").classList.remove("active");
  } else {
    savedView = camera.position.clone();
    const dist = camera.position.distanceTo(orbit.target);
    camera.position.set(orbit.target.x, orbit.target.y + dist, orbit.target.z + 0.01);
    $("#btn-top").classList.add("active");
  }
  orbit.update();
}

// ---------- cursor coordinates ----------
renderer.domElement.addEventListener("pointermove", () => {
  if (!cursorGround) { $("#cursor-pos").textContent = ""; return; }
  const { x, z } = cursorGround;
  const p = primary();
  const dist = p ? `  ·  ${tr("{0} from the selection").replace("{0}", Math.hypot(x - p.position.x, z - p.position.z).toFixed(1))}` : "";
  $("#cursor-pos").textContent = `x ${x.toFixed(1)}  z ${z.toFixed(1)}  ·  tile ${Math.floor(x / 10)},${Math.floor(z / 10)}` + dist;
});

// ---------- autosave drafts every 60 s while there are unsaved changes ----------
setInterval(async () => {
  if (!dirty || !doc || !presetPath) return;
  const r = await postJSON("draft", { path: presetPath }, doc);
  if (r.ok) setStatus(`Draft autosaved (${new Date().toLocaleTimeString(locale())})`);
}, 60000);

// ---------- UI wiring ----------
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
  for (const t of ["presets", "models", "objects", "npcs"]) $("#pane-" + t).classList.toggle("hidden", b.dataset.tab !== t);
  if (b.dataset.tab === "npcs") loadNpcs();
}));

function setSpace(local) {
  gizmo.setSpace(local ? "local" : "world");
  $("#btn-space").textContent = local ? "Local" : "World";
  $("#btn-space").classList.toggle("active", local);
  localStorage.setItem("gizmoSpace", local ? "local" : "world");
}
function setMode(m) {
  gizmo.setMode(m);
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
}
document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function applySnap() {
  const on = $("#snap").checked;
  gizmo.setTranslationSnap(on ? +$("#snap-t").value || null : null);
  gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(+$("#snap-r").value || 15) : null);
  gizmo.setScaleSnap(on ? +$("#snap-s").value || null : null);
  for (const id of ["snap-t", "snap-r", "snap-s"]) localStorage.setItem(id, $("#" + id).value);
}
for (const id of ["snap-t", "snap-r", "snap-s"]) {
  if (localStorage.getItem(id)) $("#" + id).value = localStorage.getItem(id);
  $("#" + id).addEventListener("change", applySnap);
}
$("#snap").addEventListener("change", applySnap);
$("#btn-space").addEventListener("click", () => setSpace(gizmo.space !== "local"));
setSpace(localStorage.getItem("gizmoSpace") === "local");
applySnap();

// Changing the LOD reloads the map from disk, so unsaved edits would be lost: ask first.
$("#lod").addEventListener("change", (e) => {
  if (dirty && !confirm("The level of detail reloads the map. Discard unsaved changes?")) {
    e.target.value = String(lod);
    return;
  }
  lod = +e.target.value;
  if (presetPath) { dirty = false; openPreset(presetPath); }
});
$("#btn-save").addEventListener("click", save);
$("#btn-undo").addEventListener("click", undo);
$("#btn-redo").addEventListener("click", redo);
$("#btn-top").addEventListener("click", toggleTopView);
$("#btn-test").addEventListener("click", startTest);
$("#btn-export").addEventListener("click", async () => {
  if (dirty && !confirm("The current map has unsaved changes. Export anyway (saved work only)?")) return;
  const name = askModName();
  if (!name) return;
  const r = await postJSON("export", { name });
  setStatus(r.ok ? `Exported: ${r.data.files} file(s) to ${r.data.mod}` : `Export failed: ${r.data.error}`);
});

window.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t && (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(t.tagName) || t.isContentEditable)) return;
  if (e.altKey || e.metaKey) return;
  if (!$("#modal").classList.contains("hidden") && e.key !== "Escape") return;  // a dialog is open
  const ev = e;
  if (ev.key.length === 1) e = { key: ev.key.toLowerCase(), ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, preventDefault: () => ev.preventDefault() };
  if (e.ctrlKey && e.key === "s") { e.preventDefault(); save(); }
  else if (e.ctrlKey && e.key === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (e.ctrlKey && e.key === "y") { e.preventDefault(); redo(); }
  else if (e.key === "p" && e.shiftKey && previewPath) scatter(cursorGround ? cursorGround.clone() : null);
  else if (e.key === "p" && previewPath && cursorGround) placeModel(previewPath, cursorGround.clone());
  else if (["1", "2", "3", "4"].includes(e.key)) { if (e.ctrlKey) { e.preventDefault(); storeView(e.key); } else recallView(e.key); }
  else if (e.key === "l") { setSpace(gizmo.space !== "local"); setStatus(tr(gizmo.space === "local" ? "Gizmo: object axes" : "Gizmo: world axes")); }
  else if (e.key === "q") setTool("objects");
  else if (e.key === "b") setTool(e.shiftKey ? "blockall" : "block");
  else if (e.key === "x") setTool("clear");
  else if (e.key === "[" || e.key === "]") setBrush(e.key === "]" ? 1 : -1);
  else if (e.key === "h" && e.shiftKey) showHidden();
  else if (e.key === "h") hideSelection();
  else if (e.key === "?" || e.key === "F1") { ev.preventDefault(); showHelp(); }
  else if (e.ctrlKey && e.key === "d") { e.preventDefault(); duplicate(); }
  else if (e.ctrlKey && e.key === "a") { e.preventDefault(); selectAll(); }
  else if (e.key === "w") setMode("translate");
  else if (e.key === "e") setMode("rotate");
  else if (e.key === "r") setMode("scale");
  else if (e.key === "Delete") { if (gameSel) deleteGameObject(gameSel.userData.gameIndex); else removeSelected(); }
  else if (e.key === "o") addGameObject(cursorGround ? cursorGround.clone() : null);
  else if (e.key === "Escape") { selectGameObject(null); select([]); $("#modal").classList.add("hidden"); }
  else if (e.ctrlKey && e.key === "c") { e.preventDefault(); copySelection(); }
  else if (e.ctrlKey && e.key === "v") { e.preventDefault(); paste(); }
  else if (e.key === "g") dropToGround();
  else if (e.key === "t") toggleTopView();
  else if (e.key.startsWith("Arrow") || e.key === "PageUp" || e.key === "PageDown") {
    if (!selection.length) return;
    e.preventDefault();
    const d = (+$("#snap-t").value || 0.5) * (e.shiftKey ? 10 : 1);
    const map = { ArrowLeft: [-d, 0, 0], ArrowRight: [d, 0, 0], ArrowUp: [0, 0, -d], ArrowDown: [0, 0, d], PageUp: [0, d, 0], PageDown: [0, -d, 0] };
    nudge(...map[e.key]);
  }
  else if (e.key === "f" && primary()) orbit.target.copy(primary().getWorldPosition(new THREE.Vector3()));
});
window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

let presets = [];
function renderPresets() {
  const f = $("#preset-filter").value.toLowerCase();
  const ul = $("#preset-list");
  ul.innerHTML = "";
  const recent = f ? [] : recentMaps().filter((p) => presets.includes(p));
  if (recent.length) {
    const head = document.createElement("li");
    head.className = "list-head";
    head.textContent = "Recently opened";
    ul.appendChild(head);
    for (const p of recent) {
      const li = document.createElement("li");
      li.textContent = p.replace("data/hd/env/preset/", "");
      li.className = "recent";
      li.title = p;
      li.onclick = () => openPreset(p);
      ul.appendChild(li);
    }
    const all = document.createElement("li");
    all.className = "list-head";
    all.textContent = "All maps";
    ul.appendChild(all);
  }
  const onlyEdited = $("#preset-edited").checked;
  for (const p of presets) {
    const short = p.replace("data/hd/env/preset/", "");
    if (f && !short.includes(f)) continue;
    if (onlyEdited && !editedMaps.has(p)) continue;
    const li = document.createElement("li");
    li.textContent = short;
    li.dataset.path = p;
    li.title = p;
    if (editedMaps.has(p)) li.classList.add("edited");
    li.onclick = () => openPreset(p);
    ul.appendChild(li);
  }
}
$("#preset-filter").addEventListener("input", renderPresets);

let modelTimer = null;
$("#model-cat").addEventListener("change", searchModels);
$("#model-filter").addEventListener("input", () => {
  clearTimeout(modelTimer);
  modelTimer = setTimeout(searchModels, 250);
});
function recentModels() { return JSON.parse(localStorage.getItem("recentModels") || "[]"); }
function rememberModel(m) {
  const list = [m, ...recentModels().filter((x) => x !== m)].slice(0, 30);
  localStorage.setItem("recentModels", JSON.stringify(list));
}
let searchToken = 0;
async function searchModels() {
  const token = ++searchToken;
  const q = $("#model-filter").value.trim().toLowerCase();
  const cat = $("#model-cat").value;
  let r;
  if (cat === "__recent") {
    const items = recentModels().filter((m) => !q || m.includes(q));
    r = { items, total: items.length };
  } else if (cat === "__fav") {
    const items = favModels().filter((m) => !q || m.includes(q));
    r = { items, total: items.length };
  } else if (cat === "__own") {
    r = await (await fetch(api("models", { limit: 2000, q, own: 1 }))).json();
  } else {
    // the server filters by text only; an area needs the full match list, narrowed here
    const all = await (await fetch(api("models", { limit: cat ? 20000 : 400, q }))).json();
    const items = cat ? all.items.filter((m) => m.startsWith(`data/hd/${cat}`)) : all.items;
    r = cat ? { items: items.slice(0, 400), total: items.length } : all;
  }
  if (token !== searchToken) return;  // a newer search is running
  $("#model-count").textContent = r.total > r.items.length ? `${r.total} models (first ${r.items.length})` : `${r.total} models`;
  const ul = $("#model-list");
  ul.innerHTML = "";
  for (const m of r.items) {
    const li = document.createElement("li");
    li.textContent = m.replace("data/hd/", "");
    li.title = m;
    li.onclick = () => {
      ul.querySelectorAll("li.active").forEach((x) => x.classList.remove("active"));
      li.classList.add("active");
      previewPath = m;
      showPreview(m);
    };
    li.ondblclick = () => placeModel(m);
    ul.appendChild(li);
  }
}

window.editor = { THREE, scene, camera, orbit, selectGameObject, get gameRoot() { return gameRoot; }, get gameObjects() { return gameObjects; }, get doc() { return doc; }, get selection() { return selection; }, select, openPreset, entityObjects }; // debugging hook

(async () => {
  presets = await (await fetch(api("presets"))).json();
  await loadEdited();
  searchModels();
  setStatus(`${presets.length} map presets available`);
})();

// ---------- updates (packaged program only, see tools/updater.py) ----------
const updateBar = $("#update-bar");
function updateMessage(text, buttons = []) {
  updateBar.textContent = "";
  const span = document.createElement("span");
  span.textContent = text;
  updateBar.append(span);
  for (const [label, fn] of buttons) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", fn);
    updateBar.append(b);
  }
  updateBar.classList.toggle("hidden", !text);
}
async function waitForRestart(version) {
  for (let i = 0; i < 180; i++) {  // the launcher swaps the program and starts the new server
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const v = await (await fetch(api("version"))).json();
      if (v.version === version) return location.reload();
    } catch { /* server not back yet */ }
  }
  updateMessage(tr("The editor did not come back after the update. Please start it again."));
}
async function restartForUpdate(version) {
  if (dirty && !confirm("Discard unsaved changes?")) return;
  const r = await postJSON("update/apply");
  if (!r.ok) return updateMessage(tr("Update failed: {0}").replace("{0}", "not ready"));
  dirty = false;
  updateMessage(tr("Restarting with version {0} …").replace("{0}", version));
  waitForRestart(version);
}
async function downloadUpdate(info) {
  const r = await postJSON("update/download");
  if (!r.ok) return updateMessage(tr("Update failed: {0}").replace("{0}", r.data.error));
  const poll = async () => {
    const s = await (await fetch(api("update/state"))).json();
    if (s.phase === "downloading") {
      const pct = s.total ? Math.round((100 * s.done) / s.total) : 0;
      updateMessage(tr("Downloading update … {0} %").replace("{0}", pct));
      setTimeout(poll, 700);
    } else if (s.phase === "unpacking") {
      updateMessage(tr("Unpacking update …"));
      setTimeout(poll, 700);
    } else if (s.phase === "ready") {
      updateMessage(tr("Version {0} is ready. Save your work, then restart.").replace("{0}", s.version),
        [[tr("Restart now"), () => restartForUpdate(s.version)]]);
    } else {
      updateMessage(tr("Update failed: {0}").replace("{0}", s.error || s.phase));
    }
  };
  poll();
}
async function checkForUpdate() {
  let info;
  try {
    info = await (await fetch(api("update"))).json();
  } catch { return; }
  if (!info.packaged || !info.newer || localStorage.getItem("skipUpdate") === info.latest) return;
  const buttons = [[tr("Update now"), () => downloadUpdate(info)]];
  if (info.page) buttons.push([tr("What's new"), () => window.open(info.page, "_blank")]);
  buttons.push([tr("Later"), () => { localStorage.setItem("skipUpdate", info.latest); updateMessage(""); }]);
  updateMessage(tr("Version {0} is available (you have {1}).").replace("{0}", info.latest).replace("{1}", info.current), buttons);
}
setTimeout(checkForUpdate, 3000);

// ---------- NPC creator (tools/npc_creator.py, plugin/npc.cpp) ----------
let npcData = null;
let npcSel = -1;
async function loadNpcs() {
  npcData = await (await fetch(api("npcs"))).json();
  const look = $("#npc-look"), trade = $("#npc-trade");
  look.textContent = "";
  for (const [id, name] of Object.entries(npcData.looks)) look.append(new Option(`${id} (${name})`, id));
  trade.textContent = "";
  for (const [id, label] of Object.entries(npcData.traders)) trade.append(new Option(label, id));
  renderNpcs();
}
function renderNpcs() {
  const list = $("#npc-list");
  list.textContent = "";
  npcData.npcs.forEach((n, i) => {
    if (n.removed) return;
    const li = document.createElement("li");
    li.textContent = `${n.name} · ${n.role === "trade" ? tr("trades") : tr("talks")}`;
    li.classList.toggle("sel", i === npcSel);
    li.addEventListener("click", () => selectNpc(i));
    list.append(li);
  });
  $("#npc-form").classList.toggle("hidden", npcSel < 0);
}
function selectNpc(i) {
  npcSel = i;
  const n = npcData.npcs[i];
  $("#npc-name").value = n.name;
  $("#npc-look").value = n.look;
  $("#npc-role").value = n.role;
  $("#npc-trade").value = n.trade_like || "charsi";
  $("#npc-text").value = n.text || "";
  $("#npc-trade-row").classList.toggle("hidden", n.role !== "trade");
  $("#npc-stages-box").open = !!(n.stages && n.stages.length);
  renderStages();
  renderNpcs();
}
function renderStages() {
  const box = $("#npc-stages");
  box.textContent = "";
  const n = npcData.npcs[npcSel];
  (n.stages || []).forEach((st, k) => {
    const div = document.createElement("div");
    div.className = "npc-stage";
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.textContent = "From quest stage";
    const num = Object.assign(document.createElement("input"), { type: "number", min: 0, max: 99, value: st.stage });
    num.addEventListener("input", () => { st.stage = +num.value || 0; });
    const del = Object.assign(document.createElement("button"), { textContent: tr("Remove") });
    del.addEventListener("click", () => { n.stages.splice(k, 1); renderStages(); });
    row.append(label, num, del);
    const text = Object.assign(document.createElement("textarea"), { rows: 4, value: st.text });
    text.addEventListener("input", () => { st.text = text.value; });
    div.append(row, text);
    box.append(div);
  });
}
$("#npc-stage-add").addEventListener("click", () => {
  if (npcSel < 0) return;
  const n = npcData.npcs[npcSel];
  n.stages = n.stages || [];
  const last = n.stages.length ? n.stages[n.stages.length - 1].stage : 0;
  n.stages.push({ stage: last + 1, text: "" });
  renderStages();
});
function formToNpc() {
  if (npcSel < 0) return;
  const n = npcData.npcs[npcSel];
  n.name = $("#npc-name").value;
  n.look = $("#npc-look").value;
  n.role = $("#npc-role").value;
  n.trade_like = $("#npc-trade").value;
  n.text = $("#npc-text").value;
  $("#npc-trade-row").classList.toggle("hidden", n.role !== "trade");
}
for (const id of ["#npc-name", "#npc-look", "#npc-role", "#npc-trade", "#npc-text"])
  $(id).addEventListener("input", () => { formToNpc(); renderNpcs(); });
$("#npc-new").addEventListener("click", () => {
  if (!npcData) return;
  npcData.npcs.push({ name: tr("New NPC"), look: "charsi", role: "talk", trade_like: "charsi", text: "" });
  selectNpc(npcData.npcs.length - 1);
});
$("#npc-remove").addEventListener("click", () => {
  if (npcSel < 0) return;
  npcData.npcs[npcSel].removed = true;
  npcSel = -1;
  renderNpcs();
});
$("#npc-save").addEventListener("click", async () => {
  formToNpc();
  const r = await postJSON("npcs", {}, { npcs: npcData.npcs });
  if (!r.ok) return setStatus(tr("NPCs not saved: {0}").replace("{0}", r.data.error));
  npcData.npcs = r.data.npcs;
  renderNpcs();
  setStatus(tr("NPCs saved; place them with Add game object, then export"));
});

// ---------- own models: recolour a game model, import a mesh (tools/retexture.py, tools/meshimport.py) ----------
function readFile(input) {
  const f = input.files[0];
  if (!f) return Promise.resolve(null);
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok({ name: f.name, data: r.result });
    r.onerror = () => fail(r.error);
    r.readAsDataURL(f);
  });
}
async function showOwnModel(model) {
  $("#model-cat").value = "__own";
  $("#model-filter").value = "";
  await searchModels();
  previewPath = model;
  showPreview(model);
  const li = [...document.querySelectorAll("#model-list li")].find((x) => x.title === model);
  if (li) { li.classList.add("active"); li.scrollIntoView({ block: "nearest" }); }
}
function rtModeChanged() {
  const m = $("#rt-mode").value;
  $("#rt-tint-row").classList.toggle("hidden", m !== "tint");
  $("#rt-file-row").classList.toggle("hidden", m === "tint");
  $("#rt-repeat-row").classList.toggle("hidden", m !== "material");
}
$("#rt-mode").addEventListener("change", rtModeChanged);
rtModeChanged();
$("#rt-go").addEventListener("click", async () => {
  if (!previewPath) return setStatus(tr("Choose a model in the list first"));
  const mode = $("#rt-mode").value;
  const body = { model: previewPath, tag: $("#rt-tag").value.trim().toLowerCase(), mode };
  if (mode === "tint") {
    const hex = $("#rt-color").value;
    body.rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    body.strength = +$("#rt-strength").value;
  } else {
    const f = await readFile($("#rt-file"));
    if (!f) return setStatus(tr("Choose a picture first"));
    body.image = f.data;
    body.repeat = +$("#rt-repeat").value || 2;
  }
  setStatus(tr("Recolouring …"));
  $("#rt-go").disabled = true;
  try {
    const r = await postJSON("retexture", {}, body);
    if (!r.ok) return setStatus(tr("Recolouring failed: {0}").replace("{0}", r.data.error));
    setStatus(tr("New model {0} ({1} texture(s))").replace("{0}", r.data.model.replace("data/hd/", "")).replace("{1}", r.data.textures));
    await showOwnModel(r.data.model);
  } finally { $("#rt-go").disabled = false; }
});
$("#im-file").addEventListener("change", () => {
  const f = $("#im-file").files[0];
  if (f && !$("#im-name").value) $("#im-name").value = f.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40);
});
$("#im-go").addEventListener("click", async () => {
  const mesh = await readFile($("#im-file"));
  if (!mesh) return setStatus(tr("Choose a mesh file first"));
  const tex = await readFile($("#im-tex"));
  const body = { name: $("#im-name").value.trim().toLowerCase(), filename: mesh.name, mesh: mesh.data,
                 texture: tex ? tex.data : null, height: +$("#im-height").value || 8 };
  setStatus(tr("Importing …"));
  $("#im-go").disabled = true;
  try {
    const r = await postJSON("import", {}, body);
    if (!r.ok) return setStatus(tr("Import failed: {0}").replace("{0}", r.data.error));
    setStatus(tr("Imported {0}: {1} vertices, {2} triangles").replace("{0}", r.data.model.replace("data/hd/", ""))
      .replace("{1}", r.data.vertices).replace("{2}", r.data.triangles));
    await showOwnModel(r.data.model);
  } finally { $("#im-go").disabled = false; }
});

// ---------- hide objects (view only, not saved; hiddenIds is declared at the top) ----------
function hideSelection() {
  if (!selection.length) return;
  for (const o of selection) { o.visible = false; hiddenIds.add(o.userData.entity.id); }
  select([]);
  setStatus(tr("{0} object(s) hidden · Shift+H shows them again").replace("{0}", hiddenIds.size));
  scheduleObjectList();
}
function showHidden() {
  for (const id of hiddenIds) { const o = entityObjects.get(id); if (o) o.visible = true; }
  const n = hiddenIds.size;
  hiddenIds.clear();
  updateSelInfo();
  setStatus(tr("{0} object(s) shown again").replace("{0}", n));
  scheduleObjectList();
}

// ---------- scatter: many copies of the preview model around a point ----------
function scatterSettings() {
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  const smin = num("#sc-smin", 0.8), smax = num("#sc-smax", 1.2);
  return { count: Math.max(1, Math.min(200, Math.round(num("#sc-count", 10)))), radius: Math.max(0.5, num("#sc-radius", 15)),
           smin: Math.max(0.05, Math.min(smin, smax)), smax: Math.max(0.05, smin, smax), rotate: $("#sc-rot").checked, ground: $("#sc-ground").checked };
}
async function scatter(center) {
  if (!doc) return alert("Open a map first.");
  if (!previewPath) return setStatus(tr("Choose a model in the list first"));
  const o = scatterSettings();
  const c = center || orbit.target;
  beginEdit();
  addDependency(previewPath);
  rememberModel(previewPath);
  const base = previewPath.split("/").pop().replace(/\.model$/, "");
  const made = [];
  for (let i = 0; i < o.count; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * o.radius;
    const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
    const y = o.ground ? groundHeight(x, z) : 0;
    const s = o.smin + Math.random() * (o.smax - o.smin);
    const q = o.rotate ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2) : new THREE.Quaternion();
    const name = `${base}_${Date.now() % 100000}_${i}`;
    const ent = {
      type: "Entity", name, id: newId(), components: [
        { type: "TransformDefinitionComponent", name: `${name}_TransformDefinitionComponent`,
          position: { x, y, z }, orientation: { x: q.x, y: q.y, z: q.z, w: q.w }, scale: { x: s, y: s, z: s }, inheritOnlyPosition: false },
        { type: "ModelPlatformTierComponent", name: `${name}_ModelPlatformTierComponent`, visibilityTier: 0, shadowTier: 0 },
        { type: "ModelDefinitionComponent", name: `${name}_ModelDefinitionComponent`, filename: previewPath,
          visibleLayers: 1, lightMask: 19, shadowMask: 3, ghostShadows: false, floorModel: false,
          terrainBlendEnableYUpBlend: false, terrainBlendMode: 1 },
      ],
    };
    doc.entities.push(ent);
    made.push(addObjectFor(ent));
  }
  select(await Promise.all(made));
  markDirty();
  setStatus(tr("{0} copies of {1} scattered").replace("{0}", o.count).replace("{1}", base));
}
for (const id of ["sc-count", "sc-radius", "sc-smin", "sc-smax", "sc-rot", "sc-ground"]) {
  const el = $("#" + id), key = "scatter-" + id, saved = localStorage.getItem(key);
  if (saved !== null) { if (el.type === "checkbox") el.checked = saved === "1"; else el.value = saved; }
  el.addEventListener("change", () => localStorage.setItem(key, el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value));
}
$("#sc-go").addEventListener("click", () => scatter(null));

// ---------- keyboard help ----------
const HELP_TEXT = "Mouse\n  Left click: select · Shift+click: add/remove · drag: box selection\n  Right mouse: turn the view · middle mouse: pan · wheel: zoom\n\nObjects\n  W / E / R: move / rotate / scale        Del: delete\n  Ctrl+C / Ctrl+V: copy / paste at the mouse cursor (also into other maps)\n  Ctrl+D: duplicate                        G: drop to the ground\n  Ctrl+A: select all\n  Arrow keys: move one snap step (Shift ×10), Page Up/Down: height\n  H: hide the selection                    Shift+H: show all hidden objects\n  F: focus the selection                   Esc: deselect\n\nPlacing\n  P: place the preview model at the mouse cursor\n  Shift+P: scatter the preview model around the mouse cursor (settings in the Models tab)\n  O: add a game object at the mouse cursor\n\nView and files\n  T: top view                              Ctrl+S: save\n  Ctrl+1..4: store the view, 1..4: go back to it\n  Ctrl+Z / Ctrl+Y: undo / redo             ? or F1: this help\n\nCollision\n  Q: objects tool    B: block (Shift+B: block + teleport)    X: clear    [ / ]: brush size\n\nGizmo\n  L: axes of the world or of the selected object";
function showHelp() { modalShow(tr("Keyboard and mouse"), tr(HELP_TEXT)); }
$("#btn-help").addEventListener("click", showHelp);
$("#btn-help2").addEventListener("click", showHelp);
$("#brush").classList.add("hidden");

// ---------- favourite models ----------
function favModels() { return JSON.parse(localStorage.getItem("favModels") || "[]"); }
function updateFavButton() {
  const on = previewPath && favModels().includes(previewPath);
  $("#fav-btn").textContent = on ? "★" : "☆";
  $("#fav-btn").classList.toggle("active", !!on);
}
$("#fav-btn").addEventListener("click", () => {
  if (!previewPath) return setStatus(tr("Choose a model in the list first"));
  const list = favModels();
  const on = list.includes(previewPath);
  localStorage.setItem("favModels", JSON.stringify(on ? list.filter((m) => m !== previewPath) : [previewPath, ...list]));
  updateFavButton();
  setStatus(on ? tr("Removed from the favourites") : tr("Added to the favourites"));
  if ($("#model-cat").value === "__fav") searchModels();
});

// ---------- camera bookmarks: Ctrl+1..4 stores the view of this map, 1..4 goes back to it ----------
function viewKey() { return "views:" + presetPath; }
function storeView(n) {
  if (!presetPath) return;
  const views = JSON.parse(localStorage.getItem(viewKey()) || "{}");
  views[n] = { p: camera.position.toArray(), t: orbit.target.toArray() };
  localStorage.setItem(viewKey(), JSON.stringify(views));
  setStatus(tr("View {0} stored (key {0} goes back to it)").replace(/\{0\}/g, n));
}
function recallView(n) {
  if (!presetPath) return;
  const v = JSON.parse(localStorage.getItem(viewKey()) || "{}")[n];
  if (!v) return setStatus(tr("No view {0} yet: Ctrl+{0} stores the current view").replace(/\{0\}/g, n));
  camera.position.fromArray(v.p);
  orbit.target.fromArray(v.t);
  orbit.update();
  setStatus(tr("View {0}").replace("{0}", n));
}

// ---------- maps saved in the project ----------
let editedMaps = new Set();
async function loadEdited() {
  try { editedMaps = new Set(await (await fetch(api("edited"))).json()); } catch { editedMaps = new Set(); }
  renderPresets();
}
$("#preset-edited").addEventListener("change", renderPresets);

// ---------- align, distribute, rows ----------
function alignTo(axis) {
  const p = primary();
  if (!p || selection.length < 2) return;
  const v = p.position[axis];
  return transformSelection((o) => { o.position[axis] = v; }, tr("Aligned to {0}").replace("{0}", p.userData.entity.name));
}
function distribute(axis) {
  if (selection.length < 3) return setStatus(tr("Select at least three objects"));
  const sorted = [...selection].sort((a, b) => a.position[axis] - b.position[axis]);
  const lo = sorted[0].position[axis], hi = sorted[sorted.length - 1].position[axis];
  const step = (hi - lo) / (sorted.length - 1);
  const at = new Map(sorted.map((o, i) => [o, lo + i * step]));
  return transformSelection((o) => { o.position[axis] = at.get(o); }, tr("Spaced evenly"));
}
async function makeRow() {
  const p = primary();
  if (!p || selection.length !== 1) return;
  const answer = prompt("Copies in a row: count, step x, step z (units, 10 = 1 tile)", localStorage.getItem("rowArgs") || "5, 10, 0");
  if (!answer) return;
  const [count, dx, dz] = answer.split(/[,; ]+/).map(Number);
  if (!(count >= 1 && count <= 100) || !Number.isFinite(dx) || !Number.isFinite(dz)) return setStatus(tr("Count 1-100 and two numbers, e.g. 5, 10, 0"));
  localStorage.setItem("rowArgs", answer);
  beginEdit();
  const src = p.userData.entity;
  const made = [p];
  for (let i = 1; i <= count; i++) {
    const ent = JSON.parse(JSON.stringify(src));
    ent.id = newId();
    ent.name = `${src.name}_${i}`;
    const t = comp(ent, "TransformDefinitionComponent");
    if (t) { t.position.x += dx * i; t.position.z += dz * i; }
    doc.entities.push(ent);
    made.push(await addObjectFor(ent));
  }
  select(made);
  markDirty();
  setStatus(tr("{0} copies in a row").replace("{0}", count));
}

// ---------- replace models, select by model, select all ----------
async function replaceWithPreview() {
  if (!previewPath) return setStatus(tr("Choose a model in the list first"));
  const targets = selection.filter((o) => comp(o.userData.entity, "ModelDefinitionComponent"));
  if (!targets.length) return setStatus(tr("The selection has no models"));
  beginEdit();
  addDependency(previewPath);
  rememberModel(previewPath);
  const next = [];
  for (const o of selection) {
    const ent = o.userData.entity;
    const md = comp(ent, "ModelDefinitionComponent");
    if (!md) { next.push(o); continue; }
    md.filename = previewPath;
    root.remove(o);
    entityObjects.delete(ent.id);
    next.push(await addObjectFor(ent));
  }
  select(next);
  markDirty();
  setStatus(tr("{0} model(s) replaced by {1}").replace("{0}", targets.length).replace("{1}", previewPath.split("/").pop()));
}
function selectSameModel() {
  const md = primary() && comp(primary().userData.entity, "ModelDefinitionComponent");
  if (!md) return setStatus(tr("The selection has no models"));
  const same = [...entityObjects.values()].filter((o) => o.visible && !o.userData.terrain &&
    comp(o.userData.entity, "ModelDefinitionComponent")?.filename === md.filename);
  select([...same.filter((o) => o !== primary()), primary()]);
  setStatus(tr("{0} object(s) with the model {1}").replace("{0}", same.length).replace("{1}", md.filename.split("/").pop()));
}
function selectAll() {
  if (!doc) return;
  const all = [...entityObjects.values()].filter((o) => o.visible && !o.userData.terrain &&
    (showHelpers || !(o.children[0] && o.children[0].userData.helper)));
  select(all);
  setStatus(tr("{0} object(s) selected").replace("{0}", all.length));
}

// ---------- screenshot of the view (PNG download, without the gizmo and selection boxes) ----------
function screenshot() {
  const hide = [gizmo.getHelper ? gizmo.getHelper() : gizmo, ...selectionBoxes].filter((o) => o.visible);
  const shown = grid.visible;
  for (const o of hide) o.visible = false;
  grid.visible = false;
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  for (const o of hide) o.visible = true;
  grid.visible = shown;
  const name = (presetPath ? presetPath.replace("data/hd/env/preset/", "").replace(/[\/.]+/g, "_").replace(/_json$/, "") : "view") +
    "_" + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "") + ".png";
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setStatus(tr("Screenshot saved: {0} (downloads folder)").replace("{0}", name));
}
$("#btn-shot").addEventListener("click", screenshot);
$("#follow-ground").checked = localStorage.getItem("followGround") === "1";
$("#follow-ground").addEventListener("change", (e) => localStorage.setItem("followGround", e.target.checked ? "1" : "0"));
