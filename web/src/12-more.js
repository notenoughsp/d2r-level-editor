// State in this part is `var`: earlier parts may call these functions while the page starts.

// ---------- lock objects: they stay visible but cannot be picked (per map, remembered) ----------
var lockedIds = new Set();
function lockKey() { return `locked:${window.projectName || ""}:${presetPath}`; }
function loadLocks() {
  lockedIds = new Set(JSON.parse(localStorage.getItem(lockKey()) || "[]"));
}
function saveLocks() {
  if (lockedIds.size) localStorage.setItem(lockKey(), JSON.stringify([...lockedIds]));
  else localStorage.removeItem(lockKey());
}
function pickable(o) {
  return !(lockedIds && o?.userData.entity && lockedIds.has(o.userData.entity.id));
}
function lockSelection() {
  if (!selection.length) return;
  for (const o of selection) lockedIds.add(o.userData.entity.id);
  saveLocks();
  const n = selection.length;
  select([]);
  setStatus(tr("{0} object(s) locked · Ctrl+Shift+L unlocks all").replace("{0}", n));
  renderObjectList();
}
function unlockAll() {
  const n = lockedIds.size;
  lockedIds.clear();
  saveLocks();
  setStatus(tr("{0} object(s) unlocked").replace("{0}", n));
  renderObjectList();
}

// ---------- the object under the mouse gets a thin box ----------
var hoverBox = null;
function showHoverBox(o) {
  if (!options.hoverBox || !o || selection.includes(o)) o = null;
  if (hoverBox && hoverBox.userData.obj === o) return;
  if (hoverBox) { scene.remove(hoverBox); hoverBox.geometry.dispose(); hoverBox = null; }
  if (!o) return;
  hoverBox = new THREE.BoxHelper(o, 0x8fb3ff);
  hoverBox.material.transparent = true;
  hoverBox.material.opacity = 0.6;
  hoverBox.userData.obj = o;
  scene.add(hoverBox);
}

// ---------- more object tools: random size, onto the grid, reset rotation or size ----------
function randomSize() {
  return transformSelection((o) => o.scale.multiplyScalar(0.9 + Math.random() * 0.2),
    tr("{0} object(s) got a random size (±10%)").replace("{0}", selection.length));
}
function snapToGrid() {
  const s = +$("#snap-t").value || 0.5;
  return transformSelection((o) => { o.position.x = Math.round(o.position.x / s) * s; o.position.z = Math.round(o.position.z / s) * s; },
    tr("Onto the grid ({0} units)").replace("{0}", s));
}
function resetRotation() {
  return transformSelection((o) => o.quaternion.identity(), tr("Rotation reset"));
}
function resetSize() {
  return transformSelection((o) => o.scale.set(1, 1, 1), tr("Size reset"));
}
// Shift+, / Shift+.: the whole selection turns around its middle
function turnGroup(sign) {
  if (!selection.length) return;
  const deg = (+$("#snap-r").value || 15) * sign;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
  const c = new THREE.Box3().setFromPoints(selection.map((o) => o.position)).getCenter(new THREE.Vector3());
  return transformSelection((o) => {
    o.position.sub(c).applyQuaternion(q).add(c);
    o.quaternion.premultiply(q);
  }, tr("Selection turned by {0}° around its middle").replace("{0}", deg));
}
async function copyAsJson() {
  if (!selection.length) return;
  const text = JSON.stringify(selection.map((o) => o.userData.entity), null, 1);
  try { await navigator.clipboard.writeText(text); setStatus(tr("{0} object(s) copied as JSON").replace("{0}", selection.length)); }
  catch { setStatus(tr("The clipboard could not be used")); }
}
async function renameObject(o, name) {
  name = name.trim();
  if (!name || name === o.userData.entity.name) return;
  beginEdit();
  o.userData.entity.name = name;
  markDirty();
  renderObjectList();
  setStatus(tr("Renamed to {0}").replace("{0}", name));
}

// ---------- the map's border (its size in tiles, from the DS1) ----------
function updateMapBorder(c) {
  if (scene.userData.border) { scene.remove(scene.userData.border); scene.userData.border.geometry.dispose(); scene.userData.border = null; }
  if (!c) return;
  const W = c.width * 10, H = c.height * 10;
  const pts = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, z]) => new THREE.Vector3(x, 0.2, z));
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: 0xc7a35a, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.8 }));
  line.computeLineDistances();
  line.raycast = () => {};
  scene.add(line);
  scene.userData.border = line;
}

// ---------- map statistics (View menu) ----------
function mapStats() {
  if (!doc) return setStatus(tr("Open a map first."));
  const kinds = new Map(), models = new Map();
  for (const e of doc.entities) {
    const k = kindOf(e)[1];
    kinds.set(k, (kinds.get(k) || 0) + 1);
    const md = comp(e, "ModelDefinitionComponent");
    if (md?.filename) { const m = md.filename.split("/").pop().replace(/(_lod\d)?\.model$/, ""); models.set(m, (models.get(m) || 0) + 1); }
  }
  const go = gameObjects?.objects || [];
  const lines = [
    presetPath.replace("data/hd/env/preset/", ""),
    coll ? tr("Size: {0} × {1} tiles").replace("{0}", coll.width).replace("{1}", coll.height) : "",
    tr("{0} objects, {1} different models").replace("{0}", doc.entities.length).replace("{1}", models.size),
    tr("Game objects: {0} NPCs/monsters, {1} objects").replace("{0}", go.filter((g) => g.type === 1).length).replace("{1}", go.filter((g) => g.type !== 1).length),
    tr("Hidden: {0} · locked: {1}").replace("{0}", hiddenIds.size).replace("{1}", lockedIds.size),
    "", tr("By kind"),
    ...[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(5)}  ${tr(k)}`),
    "", tr("Most used models"),
    ...[...models].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([m, n]) => `  ${String(n).padStart(5)}  ${m}`),
  ].filter((l, i) => l !== "" || i > 4);
  $("#view-pop").classList.add("hidden");
  modalShow(tr("Map statistics"), lines.join("\n"));
}

// ---------- notes per map (kept in the browser, per project) ----------
function noteKey() { return `note:${window.projectName || ""}:${presetPath}`; }
function showNote() {
  const box = $("#map-note");
  if (!box) return;
  box.value = presetPath ? localStorage.getItem(noteKey()) || "" : "";
  box.disabled = !presetPath;
}
$("#map-note")?.addEventListener("input", () => {
  if (!presetPath) return;
  const v = $("#map-note").value;
  if (v.trim()) localStorage.setItem(noteKey(), v); else localStorage.removeItem(noteKey());
});

// ---------- frames per second in the status bar (option) ----------
var fpsCount = 0, fpsLast = performance.now();
function countFrame() {
  if (!options.showFps) return;
  fpsCount++;
  const now = performance.now();
  if (now - fpsLast >= 1000) {
    $("#fps").textContent = `${Math.round(fpsCount * 1000 / (now - fpsLast))} fps`;
    fpsCount = 0;
    fpsLast = now;
  }
}

// ---------- options window: a search field ----------
function filterOptions(q) {
  for (const l of document.querySelectorAll("#opt-body label")) l.classList.toggle("hidden", !!q && !matches(`${l.textContent} ${l.dataset.en || ""}`, q));
}

$("#btn-stats").addEventListener("click", mapStats);
// the "only the selected" list follows the selection
document.addEventListener("click", () => { if ($("#object-kind").value === "__sel") scheduleObjectList(); });
