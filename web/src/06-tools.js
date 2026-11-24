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
async function scatter(center, inStroke = false) {
  if (!doc) return alert("Open a map first.");
  if (!previewPath) return setStatus(tr("Choose a model in the list first"));
  const o = scatterSettings();
  const c = center || orbit.target;
  if (!inStroke) beginEdit();
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
    const ent = modelEntity(previewPath, { x, y, z }, q, s, `_${i}`);
    doc.entities.push(ent);
    made.push(addObjectFor(ent));
  }
  const objs = await Promise.all(made);
  if (inStroke) return objs;
  select(objs);
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
const HELP_TEXT = "Mouse\n  Left click: select · Shift+click: add/remove · drag: box selection\n  Right mouse: turn the view · middle mouse: pan · wheel: zoom\n\nObjects\n  W / E / R: move / rotate / scale        Del: delete\n  Ctrl+C / Ctrl+V: copy / paste at the mouse cursor (also into other maps)\n  Ctrl+D: duplicate                        G: drop to the ground\n  Ctrl+A: select all\n  Arrow keys: move one snap step (Shift ×10), Page Up/Down: height\n  H: hide the selection                    Shift+H: show all hidden objects\n  F: focus the selection                   Esc: deselect\n\nPlacing\n  P: place the preview model at the mouse cursor\n  Shift+P: scatter the preview model around the mouse cursor (settings in the Models tab)\n  O: add a game object at the mouse cursor\n\nView and files\n  T: top view                              Ctrl+S: save\n  Ctrl+1..4: store the view, 1..4: go back to it\n  Ctrl+Z / Ctrl+Y: undo / redo             ? or F1: this help\n\nCollision\n  Q: objects tool    B: block (Shift+B: block + teleport)    X: clear    [ / ]: brush size\n\nGizmo\n  L: axes of the world or of the selected object\n  (every map opens again with the view you left it with)\n\nTools\n  M: ruler (click two points)    Mirror, circle and row copies: buttons under Selection\n  N: minimap    Ctrl+G: save the selection as a group (Objects tab)\n  C: compare with the game's original map\n  Game objects: NPCs can get a walking path (Draw a walking path), \"Add a group\" places several at once\n\nMaps and ground\n  Models tab: \"Decorate like the map\" fills an area with the map's own plants and rocks; \"Draw a path\" lays ground stamps along clicked points (Enter)\n  Maps tab: ⤓ saves the project as one file, ⤒ loads one as a new project\n  Double-click in the view: fly to the object there    Middle-click on a map tab: close it\n  Ctrl+K: search everything (maps, models, objects, kits, options)    View menu: lights, camera flight, changes against the original";
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

// ---------- keyboard in the search fields: arrows walk the list, Enter uses the entry ----------
function listKeys(input, list, onPick, onEnter) {
  input.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
    const items = [...list.querySelectorAll("li:not(.list-head)")];
    if (!items.length) return;
    e.preventDefault();
    let i = items.findIndex((li) => li.classList.contains("active"));
    if (e.key === "Enter") return onEnter(items[Math.max(0, i)]);
    i = e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
    items.forEach((li) => li.classList.remove("active"));
    items[i].classList.add("active");
    items[i].scrollIntoView({ block: "nearest" });
    onPick(items[i]);
  });
}
listKeys($("#model-filter"), $("#model-list"), (li) => li.click(), (li) => { li.click(); placeModel(li.title); });
listKeys($("#preset-filter"), $("#preset-list"), () => {}, (li) => li.click());

// ---------- the object under the mouse, named in the status bar ----------
let hoverTimer = 0;
renderer.domElement.addEventListener("pointermove", (e) => {
  if (e.buttons || tool !== "objects" || !root || !options.hoverInfo) return;
  const now = performance.now();
  if (now - hoverTimer < 120) return;
  hoverTimer = now;
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  let name = "";
  for (const h of raycaster.intersectObject(root, true)) {
    let o = h.object;
    while (o && !o.userData.entity) o = o.parent;
    if (!o || o.parent !== root || o.userData.terrain || !o.visible) continue;
    const md = comp(o.userData.entity, "ModelDefinitionComponent");
    name = md ? md.filename.split("/").pop().replace(/\.model$/, "") : o.userData.entity.name;
    break;
  }
  $("#hover-info").textContent = name;
});
renderer.domElement.addEventListener("pointerleave", () => { $("#hover-info").textContent = ""; });

// ---------- mirror the selection (layout and rotation; models themselves are not flipped) ----------
function mirror(axis) {
  if (!selection.length) return;
  const c = new THREE.Box3();
  for (const o of selection) c.expandByPoint(o.position);
  const mid = c.getCenter(new THREE.Vector3())[axis];
  return transformSelection((o) => {
    o.position[axis] = 2 * mid - o.position[axis];
    const q = o.quaternion;
    if (axis === "x") o.quaternion.set(q.x, -q.y, -q.z, q.w);
    else o.quaternion.set(-q.x, -q.y, q.z, q.w);
  }, tr("Mirrored along {0}").replace("{0}", axis));
}

// ---------- copies in a circle or an arc around the object ----------
async function makeCircle() {
  const p = primary();
  if (!p || selection.length !== 1) return;
  const answer = prompt("Copies in a circle: count, radius, arc in degrees (360 = full circle), face the centre (1 = yes)",
    localStorage.getItem("circleArgs") || "8, 15, 360, 1");
  if (!answer) return;
  const [count, radius, arc = 360, face = 1] = answer.split(/[,; ]+/).map(Number);
  if (!(count >= 2 && count <= 100) || !(radius > 0) || !(arc > 0 && arc <= 360)) return setStatus(tr("Count 2-100, radius and arc, e.g. 8, 15, 360, 1"));
  localStorage.setItem("circleArgs", answer);
  beginEdit();
  const src = p.userData.entity, centre = p.position.clone();
  const step = THREE.MathUtils.degToRad(arc) / (arc >= 360 ? count : count - 1);
  const made = [];
  for (let i = 0; i < count; i++) {
    const a = i * step;
    const ent = JSON.parse(JSON.stringify(src));
    ent.id = newId();
    ent.name = `${src.name}_c${i}`;
    const t = comp(ent, "TransformDefinitionComponent");
    if (t) {
      t.position.x = centre.x + Math.cos(a) * radius;
      t.position.z = centre.z + Math.sin(a) * radius;
      if (face) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a - Math.PI / 2).multiply(p.quaternion);
        t.orientation = { x: q.x, y: q.y, z: q.z, w: q.w };
      }
    }
    doc.entities.push(ent);
    made.push(await addObjectFor(ent));
  }
  select(made);
  markDirty();
  setStatus(tr("{0} copies in a circle").replace("{0}", count));
}

// ---------- ruler: M, then click two points ----------
let measuring = null;  // null: off, []: waiting for points
const rulerGroup = new THREE.Group();
scene.add(rulerGroup);
function clearRuler() {
  for (const o of [...rulerGroup.children]) { rulerGroup.remove(o); o.geometry?.dispose(); o.material?.map?.dispose(); }
}
function toggleRuler() {
  measuring = measuring ? null : [];
  clearRuler();
  $("#btn-ruler").classList.toggle("active", !!measuring);
  setStatus(measuring ? tr("Ruler: click two points (M or Esc ends it)") : tr("Ruler off"));
}
renderer.domElement.addEventListener("pointerdown", (e) => { if (measuring && e.button === 0) e.stopImmediatePropagation(); }, true);
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!measuring || e.button !== 0 || !cursorGround) return;
  e.stopImmediatePropagation();
  const p = cursorGround.clone();
  p.y = groundHeight(p.x, p.z) + 0.3;
  if (measuring.length >= 2) { measuring = []; clearRuler(); }
  measuring.push(p);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false }));
  dot.position.copy(p);
  dot.renderOrder = 21;
  rulerGroup.add(dot);
  if (measuring.length === 2) {
    const [a, b] = measuring;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false }));
    line.renderOrder = 21;
    rulerGroup.add(line);
    const d = a.distanceTo(b), flat = Math.hypot(a.x - b.x, a.z - b.z);
    const label = textSprite(`${d.toFixed(1)} (${(flat / 10).toFixed(1)} ${tr("tiles")})`, "#ffd400");
    label.position.copy(a).add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 3, 0));
    rulerGroup.add(label);
    setStatus(tr("Distance {0} units = {1} tiles (height difference {2})").replace("{0}", d.toFixed(2))
      .replace("{1}", (flat / 10).toFixed(2)).replace("{2}", Math.abs(a.y - b.y).toFixed(2)));
  }
}, true);
$("#btn-ruler").addEventListener("click", toggleRuler);

// ---------- collision only: models hidden, collision shown from above ----------
function setCollisionOnly(on) {
  for (const [id, o] of entityObjects) if (!o.userData.terrain) o.visible = !on && !hiddenIds.has(id);
  if (on) { $("#show-coll").checked = true; if (collMesh) collMesh.visible = true; if (!savedView) toggleTopView(); }
  $("#coll-only").checked = on;
  setStatus(on ? tr("Collision only: models hidden") : tr("Models shown again"));
}
$("#coll-only").addEventListener("change", (e) => setCollisionOnly(e.target.checked));

// ---------- undo list: jump back several steps at once ----------
function undoMenu() {
  const menu = $("#undo-menu");
  if (!menu.classList.contains("hidden")) return menu.classList.add("hidden");
  menu.textContent = "";
  const steps = undoStack.slice().reverse();
  if (!steps.length) { menu.textContent = tr("Nothing to undo"); }
  steps.slice(0, 30).forEach((entry, k) => {
    const b = document.createElement("button");
    b.textContent = `${k + 1}. ${entry.label || tr("Edit")}`;
    b.title = entry.time ? new Date(entry.time).toLocaleTimeString(locale()) : "";
    b.addEventListener("click", async () => {
      menu.classList.add("hidden");
      for (let i = 0; i <= k; i++) await undo();
      setStatus(tr("{0} step(s) undone").replace("{0}", k + 1));
    });
    menu.append(b);
  });
  const r = $("#btn-undo-list").getBoundingClientRect();
  Object.assign(menu.style, { left: `${r.left}px`, top: `${r.bottom + 2}px` });
  menu.classList.remove("hidden");
}
$("#btn-undo-list").addEventListener("click", (e) => { e.stopPropagation(); undoMenu(); });
window.addEventListener("click", (e) => { if (!e.target.closest("#undo-menu")) $("#undo-menu").classList.add("hidden"); });

// ---------- minimap (N): the whole map from above in a corner; click to look there ----------
const miniCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
miniCam.layers.enable(1);
const miniMarker = new THREE.Mesh(new THREE.RingGeometry(2.5, 4, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false }));
miniMarker.layers.set(1);
miniMarker.renderOrder = 30;
scene.add(miniMarker);
let miniOn = localStorage.getItem("minimap") === "1";
let miniBox = null, miniBoxFor = null;
function miniBounds() {
  if (miniBoxFor === presetPath && miniBox) return miniBox;
  const b = new THREE.Box3();
  if (coll) b.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(coll.width * 10, 0, coll.height * 10));
  else for (const o of entityObjects.values()) b.expandByPoint(o.position);
  if (b.isEmpty()) return null;
  miniBox = b; miniBoxFor = presetPath;
  return b;
}
function miniRect() {
  const w = viewport.clientWidth, h = viewport.clientHeight, s = Math.round(Math.min(options.minimapSize, Math.min(w, h) * 0.45));
  return { x: w - s - 10, y: 10, s, w, h };  // y from the bottom
}
function drawMinimap() {
  const hit = $("#minimap-hit");
  const b = miniOn && doc ? miniBounds() : null;
  hit.classList.toggle("hidden", !b);
  if (!b) return;
  const r = miniRect();
  const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
  const half = Math.max(size.x, size.z) / 2 + 10;
  Object.assign(miniCam, { left: -half, right: half, top: half, bottom: -half });
  miniCam.position.set(c.x, 2000, c.z);
  miniCam.up.set(0, 0, -1);
  miniCam.lookAt(c.x, 0, c.z);
  miniCam.updateProjectionMatrix();
  miniMarker.position.set(orbit.target.x, 50, orbit.target.z);
  miniMarker.scale.setScalar(half / 60);
  const helper = gizmo.getHelper ? gizmo.getHelper() : gizmo, gv = helper.visible;
  helper.visible = false;
  renderer.setScissorTest(true);
  renderer.setScissor(r.x, r.y, r.s, r.s);
  renderer.setViewport(r.x, r.y, r.s, r.s);
  renderer.render(scene, miniCam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, r.w, r.h);
  helper.visible = gv;
  Object.assign(hit.style, { width: `${r.s}px`, height: `${r.s}px`, right: "10px", bottom: "10px" });
  hit.dataset.cx = c.x; hit.dataset.cz = c.z; hit.dataset.half = half;
}
function toggleMinimap() {
  miniOn = !miniOn;
  localStorage.setItem("minimap", miniOn ? "1" : "0");
  $("#btn-mini").classList.toggle("active", miniOn);
}
$("#btn-mini").classList.toggle("active", miniOn);
$("#btn-mini").addEventListener("click", toggleMinimap);
$("#minimap-hit").addEventListener("click", (e) => {
  const el = e.currentTarget, r = el.getBoundingClientRect(), half = +el.dataset.half;
  const x = +el.dataset.cx + ((e.clientX - r.left) / r.width * 2 - 1) * half;
  const z = +el.dataset.cz + ((e.clientY - r.top) / r.height * 2 - 1) * half;
  const d = new THREE.Vector3(x - orbit.target.x, 0, z - orbit.target.z);
  orbit.target.add(d);
  camera.position.add(d);
  orbit.update();
});

// ---------- groups: named selections per map (Ctrl+G) ----------
function groupKey() { return "groups:" + (window.projectName || "") + ":" + presetPath; }
function loadGroups() { return JSON.parse(localStorage.getItem(groupKey()) || "{}"); }
function renderGroups() {
  const sel = $("#group-select");
  const groups = loadGroups();
  sel.textContent = "";
  sel.append(new Option(tr("Groups ({0})").replace("{0}", Object.keys(groups).length), ""));
  for (const [name, ids] of Object.entries(groups)) sel.append(new Option(`${name} (${ids.length})`, name));
  $("#group-del").disabled = true;
}
function saveGroup() {
  if (!presetPath || !selection.length) return setStatus(tr("Select the objects of the group first"));
  const name = prompt("Name of the group:", "");
  if (!name) return;
  const groups = loadGroups();
  groups[name.slice(0, 40)] = selection.map((o) => o.userData.entity.id);
  localStorage.setItem(groupKey(), JSON.stringify(groups));
  renderGroups();
  setStatus(tr("Group {0} saved ({1} objects)").replace("{0}", name).replace("{1}", selection.length));
}
$("#group-select").addEventListener("change", (e) => {
  const ids = loadGroups()[e.target.value];
  $("#group-del").disabled = !ids;
  if (!ids) return;
  const objs = ids.map((id) => entityObjects.get(id)).filter(Boolean);
  select(objs);
  setStatus(tr("Group {0}: {1} object(s)").replace("{0}", e.target.value).replace("{1}", objs.length));
});
$("#group-save").addEventListener("click", saveGroup);
$("#group-del").addEventListener("click", () => {
  const name = $("#group-select").value;
  if (!name || !confirm(tr("Delete the group {0}? The objects stay.").replace("{0}", name))) return;
  const groups = loadGroups();
  delete groups[name];
  localStorage.setItem(groupKey(), JSON.stringify(groups));
  renderGroups();
});

// ---------- scatter brush: paint copies of the preview model with the left mouse button ----------
let brushOn = false, brushStroke = null;
function toggleScatterBrush() {
  brushOn = !brushOn;
  $("#sc-brush").classList.toggle("active", brushOn);
  setStatus(brushOn ? tr("Scatter brush: paint with the left mouse button (Esc ends it)") : tr("Scatter brush off"));
}
$("#sc-brush").addEventListener("click", toggleScatterBrush);
renderer.domElement.addEventListener("pointerdown", async (e) => {
  if (!brushOn || e.button !== 0 || tool !== "objects") return;
  e.stopImmediatePropagation();
  if (!doc || !previewPath || !cursorGround) return setStatus(tr("Choose a model in the list first"));
  beginEdit();
  brushStroke = { last: null, made: [] };
  orbit.enabled = false;
}, true);
renderer.domElement.addEventListener("pointermove", async () => {
  if (!brushStroke || !cursorGround) return;
  const spacing = Math.max(1, scatterSettings().radius);
  if (brushStroke.last && brushStroke.last.distanceTo(cursorGround) < spacing) return;
  brushStroke.last = cursorGround.clone();
  brushStroke.made.push(...(await scatter(cursorGround.clone(), true)));
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!brushOn) return;
  e.stopImmediatePropagation();
}, true);
window.addEventListener("pointerup", async () => {
  if (!brushStroke) return;
  const s = brushStroke;
  brushStroke = null;
  orbit.enabled = true;
  if (!s.last && cursorGround) s.made.push(...(await scatter(cursorGround.clone(), true)));  // a click without moving
  if (!s.made.length) { undoStack.pop(); return; }
  markDirty();
  setStatus(tr("Scatter brush: {0} objects placed").replace("{0}", s.made.length));
});
