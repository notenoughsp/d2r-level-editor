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
  sp.userData.baseW = cv.width / 16;
  sp.userData.baseH = cv.height / 16;
  try { sp.scale.multiplyScalar(options.labelScale); sp.visible = options.labels; } catch { /* during start-up */ }
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
    if (ob.type === 1 && options.figures) {
      loadCharacter(ob.name).then((gl) => {
        if (!gl || !g.parent) return;
        const fig = animate(gl);
        fig.scale.setScalar(options.figureScale);
        fig.userData.figure = true;
        g.add(fig);
        // stand on the ground: the model's placement lifts it (feet at its lowest point in the first pose)
        fig.userData.mixer.update(0);
        fig.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(fig, true);
        fig.position.y -= box.min.y - g.position.y;
        label.position.y = (box.max.y - box.min.y) + 1.5;  // the name above the head
        if (ob.path && ob.path.length) startWalker(g, fig, label, ob);
        m.material = m.material.clone();
        m.material.opacity = 0.25;
        m.material.transparent = true;
        g.userData.baseMat = m.material;
        if (gameSel === g) { m.material = selMaterial; markFigure(g); }
      });
    }
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
  restoreAddObject();
}

function selectGameObject(g) {
  select([]);
  if (gameSel) gameSel.userData.mesh.material = gameSel.userData.baseMat || (gameObjects.objects[gameSel.userData.gameIndex].type === 1 ? npcMaterial : objMaterial);
  markFigure(g);
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
  if (g) figureProps(g);
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
    (ob.type === 1 && gameObjects.editable ? `<div class="prop-buttons"><button id="go-path" title="Click points on the ground; Enter: done, Esc: cancel">Draw a walking path</button>` +
      `${ob.path && ob.path.length ? `<button id="go-path-clear">Remove the path</button>` : ""}</div>` : "") +
    `<div class="prop-buttons"><button id="go-del">Delete</button></div>` +
    (gameObjects.editable ? "" : `<div class="prop-model">This DS1 does not allow object changes.</div>`);
  $("#go-id").onchange = () => editGameObject(gameSel.userData.gameIndex, { id: +$("#go-id").value });
  $("#go-x").onchange = $("#go-y").onchange = () => editGameObject(gameSel.userData.gameIndex, { x: +$("#go-x").value, y: +$("#go-y").value });
  $("#go-del").onclick = () => deleteGameObject(gameSel.userData.gameIndex);
  if ($("#go-path")) $("#go-path").onclick = () => startPath(gameSel.userData.gameIndex);
  if ($("#go-path-clear")) $("#go-path-clear").onclick = () => {
    const objs = currentObjects();
    objs[gameSel.userData.gameIndex].path = [];
    sendGameObjects(objs, beginEdit());
  };
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
  const list = f ? all.filter((e) => matches(`${e.id}: ${e.name}`, f)) : all;
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
function randomRotate(steps = false) {
  const snap = THREE.MathUtils.degToRad(+$("#snap-r").value || 15);
  return transformSelection((o) => {
    const a = Math.random() * Math.PI * 2;
    o.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), steps ? Math.round(a / snap) * snap : a));
  }, steps ? tr("Rotated at random in steps of {0}°").replace("{0}", $("#snap-r").value) : "Rotated at random");
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
  localStorage.setItem("d2r-clip-last", "entity");
  setStatus(`${items.length} object(s) copied`);
}
async function paste(fromKit = null, inPlace = false) {
  const clip = fromKit || JSON.parse(localStorage.getItem("d2r-clipboard") || "null");
  if (!clip || !doc) return setStatus("The clipboard is empty");
  beginEdit();
  const target = cursorGround ? cursorGround.clone() : orbit.target.clone();
  const step = +$("#snap-t").value || 0.5;
  const snap = (v) => ($("#snap").checked ? Math.round(v / step) * step : v);
  // snap the common offset only, so the copied group keeps its exact layout
  const dx = inPlace ? 0 : snap(target.x - clip.anchor[0]), dz = inPlace ? 0 : snap(target.z - clip.anchor[2]);
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
  if ($("#follow-ground").checked && !inPlace) {
    for (const o of created) { o.position.y = groundHeight(o.position.x, o.position.z); writeTransform(o); }
  }
  select(created);
  markDirty();
  setStatus(`${created.length} object(s) pasted`);
  return [dx, dz];
}

// ---------- marquee (rectangle) selection with the left mouse button ----------
let marquee = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (tool !== "objects" || e.button !== 0 || gizmo.axis) return;
  marquee = { x: e.clientX, y: e.clientY, active: false, add: e.shiftKey, remove: e.ctrlKey };
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
    if (o.userData.terrain || !o.visible || !pickable(o)) continue;
    if (!showHelpers && o.children[0] && o.children[0].userData.helper) continue;
    v.copy(o.position).project(camera);
    if (v.z > 1) continue;
    const sx = r.left + ((v.x + 1) / 2) * r.width, sy = r.top + ((1 - v.y) / 2) * r.height;
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) hits.push(o);
  }
  select(m.remove ? selection.filter((o) => !hits.includes(o)) : m.add ? [...new Set([...selection, ...hits])] : hits);
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
  const y = root ? groundHeight(x, z) : 0;
  $("#cursor-pos").textContent = `x ${x.toFixed(1)}  z ${z.toFixed(1)}  ${tr("height")} ${(y || 0).toFixed(1)}  ·  tile ${Math.floor(x / 10)},${Math.floor(z / 10)}` + dist;
});

// ---------- autosave drafts every 60 s while there are unsaved changes ----------
// (the autosave timer is set by applyOptions, see the options window)
