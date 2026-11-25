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
    if (o && o.parent === root && !o.userData.terrain && o.visible && pickable(o)) { hit = o; break; }
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
  if (objs.length && gameSelBox) markFigure(null);
  if (objs.length && gameSel) { gameSel.userData.mesh.material = gameObjects.objects[gameSel.userData.gameIndex].type === 1 ? npcMaterial : objMaterial; gameSel = null; gizmo.showY = true; applySnap(); }
  selection = objs.filter(Boolean);
  rememberSelection(selection);
  for (const b of selectionBoxes.splice(0)) { scene.remove(b); b.geometry.dispose(); }
  for (const o of selection) {
    const b = new THREE.BoxHelper(o, o === primary() ? options.selColor : 0xc7a35a);
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
    const n = selection.length, mode = gizmo.getMode();
    setStatus(tr(mode === "rotate" ? "{0} object(s) rotated" : mode === "scale" ? "{0} object(s) scaled" : "{0} object(s) moved").replace("{0}", n));
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
  showDragAmount();
});

// "3× barrel01, 2× crate02": the selection by model (or name), most first
function groupedNames(objs) {
  const counts = new Map();
  for (const o of objs) {
    const md = comp(o.userData.entity, "ModelDefinitionComponent");
    const key = md?.filename ? md.filename.split("/").pop().replace(/(_lod\d)?\.model$/, "") : o.userData.entity.name;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const rows = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${esc(k)}`);
  return rows.slice(0, 12).join("<br>") + (rows.length > 12 ? `<br>… (${rows.length - 12} more)` : "");
}
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
    `<div class="prop-buttons"><button id="b-variants" title="Copies of the selected objects at the same places in the other variants of this map (the game picks one of them at random)">Copy into the variants</button></div>` +
    `<div class="prop-buttons"><button id="b-mx" title="Mirror the selection along x (positions and rotations)">Mirror x</button><button id="b-mz" title="Mirror the selection along z (positions and rotations)">Mirror z</button></div>` +
    `<div class="prop-buttons"><button id="b-ground" title="G: put onto the terrain height">Drop to ground</button><button id="b-rand" title="Turn at random around the vertical axis (looks natural for plants and rocks)">Random rotation</button></div>` +
    `<div class="prop-buttons"><button id="b-rsize" title="Each object a little bigger or smaller (±10%)">Random size</button><button id="b-grid" title="Positions onto the move snap grid">Onto the grid</button></div>` +
    `<div class="prop-buttons"><button id="b-r0" title="Rotation back to 0">Reset rotation</button><button id="b-s0" title="Size back to 1">Reset size</button></div>` +
    `<div class="prop-buttons"><button id="b-coll" title="Block the tiles under the object; the blocked area moves with the object">Collision under object</button></div>`;
  if (selection.length > 1) {
    el.innerHTML = `<div class="sel-count">${selection.length} objects selected</div>` +
      `<div class="prop-model">${groupedNames(selection)}</div>` +
      `<div class="prop-model">${selectionExtent()}</div>` +
      `<div class="prop-buttons"><button id="b-ax" title="Same x as the last picked object (yellow box)">Align x</button><button id="b-az" title="Same z as the last picked object (yellow box)">Align z</button><button id="b-ay" title="Same height as the last picked object (yellow box)">Align height</button></div>` +
      `<div class="prop-buttons"><button id="b-dx" title="Same distance between the objects along x (at least three objects)">Space along x</button><button id="b-dz" title="Same distance between the objects along z (at least three objects)">Space along z</button></div>` +
      `<div class="prop-buttons"><button id="b-samer" title="All get the rotation of the last picked object (yellow box)">Same rotation</button><button id="b-sames" title="All get the size of the last picked object (yellow box)">Same size</button></div>` +
      `<div class="prop-buttons"><button id="b-thin" title="Keep about every second object of the selection (at random), e.g. to thin out scattered plants">Thin out</button><button id="b-jitter" title="Move each object a little at random (up to the move snap, at least 2 units)">Shift at random</button></div>` + buttons;
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
    const rowBtn = `<div class="prop-buttons"><button id="b-row" title="Copies of the object in a straight line, e.g. a fence or a row of torches">Copies in a row</button><button id="b-circle" title="Copies around the object in a circle or an arc, e.g. a stone circle">Copies in a circle</button></div>`;
    el.innerHTML = `<input class="prop-name" id="p-name" title="${tr("Name of the object (Enter keeps it)")}" spellcheck="false"><div class="prop-model">${what}</div>` + linked + explode + rowBtn +
      row("Position", "p", [o.position.x, o.position.y, o.position.z].map((v) => v.toFixed(2))) +
      row("Rotation°", "r", [deg(e.x), deg(e.y), deg(e.z)]) +
      row("Scaling", "s", [o.scale.x, o.scale.y, o.scale.z].map((v) => v.toFixed(3))) +
      lightProps(o) +
      `<div class="prop-row"><span title="${tr("Scale on all axes at once")}">${tr("Size")}</span><input type="number" step="0.05" min="0.01" id="p-uniform" value="${o.scale.x.toFixed(3)}"></div>` + buttons;
    wireLightProps(o);
    $("#p-name").value = ent.name;
    $("#p-name").addEventListener("change", (ev) => renameObject(o, ev.target.value));
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
  $("#b-rand").onclick = (e) => randomRotate(e.shiftKey);
  $("#b-rsize").onclick = randomSize;
  if ($("#b-samer")) { $("#b-samer").onclick = sameRotation; $("#b-sames").onclick = sameSize; $("#b-thin").onclick = thinOut; $("#b-jitter").onclick = jitter; }
  $("#b-grid").onclick = snapToGrid;
  $("#b-r0").onclick = resetRotation;
  $("#b-s0").onclick = resetSize;
  $("#b-coll").onclick = blockUnderSelection;
  $("#b-del").onclick = removeSelected;
  if ($("#b-explode")) $("#b-explode").onclick = explodePrefab;
  if ($("#b-row")) $("#b-row").onclick = makeRow;
  if ($("#b-circle")) $("#b-circle").onclick = makeCircle;
  $("#b-mx").onclick = () => mirror("x");
  $("#b-variants").onclick = copyToVariants;
  $("#b-mz").onclick = () => mirror("z");
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
  entry.time = Date.now();
  undoStack.push(entry);
  while (undoStack.length > (options.undoSteps || 100)) undoStack.shift();
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
  const last = (s) => (s.length && s[s.length - 1].label ? ` · ${tr(s[s.length - 1].label)}` : "");
  $("#btn-undo").title = tr("Ctrl+Z · {0} step(s)").replace("{0}", undoStack.length) + last(undoStack);
  $("#btn-redo").title = tr("Ctrl+Y · {0} step(s)").replace("{0}", redoStack.length) + last(redoStack);
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

// A new model entity as the game's presets have them: transform, platform tier and model.
// quat: THREE.Quaternion or null; scale: a number.
function modelEntity(modelPath, pos, quat = null, scale = 1, suffix = "") {
  const base = modelPath.split("/").pop().replace(/\.model$/, "");
  const name = `${base}_${Date.now() % 100000}${suffix}`;
  const q = quat || { x: 0, y: 0, z: 0, w: 1 };
  addDependency(modelPath);
  return {
    type: "Entity", name, id: newId(), components: [
      { type: "TransformDefinitionComponent", name: `${name}_TransformDefinitionComponent`, position: { x: pos.x, y: pos.y, z: pos.z },
        orientation: { x: q.x, y: q.y, z: q.z, w: q.w }, scale: { x: scale, y: scale, z: scale }, inheritOnlyPosition: false },
      { type: "ModelPlatformTierComponent", name: `${name}_ModelPlatformTierComponent`, visibilityTier: 0, shadowTier: 0 },
      { type: "ModelDefinitionComponent", name: `${name}_ModelDefinitionComponent`, filename: modelPath,
        visibleLayers: 1, lightMask: 19, shadowMask: 3, ghostShadows: false, floorModel: false,
        terrainBlendEnableYUpBlend: false, terrainBlendMode: 1 },
    ],
  };
}

async function placeModel(modelPath, at = null) {
  if (!doc) return setStatus(tr("Open a map first."));
  beginEdit();
  const base = modelPath.split("/").pop().replace(/\.model$/, "");
  const tgt = at || orbit.target;
  const ent = modelEntity(modelPath, { x: Math.round(tgt.x * 2) / 2, y: 0, z: Math.round(tgt.z * 2) / 2 });
  rememberModel(modelPath);
  doc.entities.push(ent);
  select([await addObjectFor(ent)]);
  markDirty();
  setStatus(`${base} placed`);
}

async function duplicate() {
  if (!selection.length) return;
  const repeat = duplicateOffset();  // the last copy was moved: the next one goes the same way
  const from = selection.map((o) => o.position.clone());
  beginEdit();
  const copies = [];
  for (const o of selection) {
    const src = o.userData.entity;
    const ent = JSON.parse(JSON.stringify(src));
    ent.id = newId();
    ent.name = copyName(src.name);
    const t = comp(ent, "TransformDefinitionComponent");
    if (t && repeat) { t.position.x = o.position.x + repeat.x; t.position.y = o.position.y + repeat.y; t.position.z = o.position.z + repeat.z; }
    else if (t) { t.position.x += options.dupOffset; t.position.z += options.dupOffset; }
    doc.entities.push(ent);
    copies.push(await addObjectFor(ent));
  }
  select(copies);
  lastDup = { from, copies: copies.slice() };
  markDirty();
}

async function removeSelected() {
  if (!selection.length) return;
  if (options.confirmDelete && selection.length > options.confirmDelete && !confirm(tr("Delete {0} objects?").replace("{0}", selection.length))) return;
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
  if (!dirty) return setStatus(tr("Nothing to save"));
  const r = await postJSON("preset", { path: presetPath }, doc);
  if (r.ok) {
    dirty = false;
    const tab = mapTabs.find((t) => t.path === presetPath);
    if (tab) { tab.draft = false; saveTabs(); }
    renderTabs();
    updateSceneInfo();
    setStatus("Saved: " + presetPath.replace("data/hd/env/preset/", ""));
    $("#btn-save").title = tr("Ctrl+S · last saved {0}").replace("{0}", new Date().toLocaleTimeString(locale()));
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
  if (c || !presetPath) updateMapBorder(c);
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
const cellSize = () => 10;  // collision is painted per tile (finer does not work in the game)

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
  const ops = [...cells.values()].map(([x, y]) => ({ tx: x, ty: y, mode: tool }));
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
