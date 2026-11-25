// State in this part is `var`: earlier parts may call these functions while the page starts.

// ---------- camera: number pad zoom, front and side views, turntable, fog ----------
function zoomStep(f) {
  camAnim = null;
  camera.position.sub(orbit.target).multiplyScalar(f).add(orbit.target);
  orbit.update();
}
// Number pad 1: from the front (looking north), 3: from the side (looking west)
function axisView(side) {
  camAnim = null;
  const d = camera.position.distanceTo(orbit.target);
  const dir = side ? new THREE.Vector3(1, 0.6, 0) : new THREE.Vector3(0, 0.6, 1);
  camera.position.copy(orbit.target).addScaledVector(dir.normalize(), d);
  orbit.update();
  setStatus(tr(side ? "View from the side" : "View from the front"));
}
$("#turntable").addEventListener("change", () => {
  orbit.autoRotate = $("#turntable").checked;
  orbit.autoRotateSpeed = 1.5;
});
function applyFog() {
  const on = $("#fog").checked;
  scene.fog = on ? new THREE.Fog(scene.background.getHex(), 60, 420) : null;
  localStorage.setItem("view:fog", on ? "1" : "0");
}
$("#fog").checked = localStorage.getItem("view:fog") === "1";
$("#fog").addEventListener("change", applyFog);
applyFog();
// the stored views 1-4 as buttons in the View menu
function renderViewButtons() {
  const box = $("#view-buttons");
  if (!box) return;
  const views = presetPath ? JSON.parse(localStorage.getItem(viewKey()) || "{}") : {};
  box.textContent = "";
  for (const n of ["1", "2", "3", "4"]) {
    const b = document.createElement("button");
    b.textContent = n;
    b.disabled = !views[n];
    b.title = views[n] ? tr("Go to view {0}").replace("{0}", n) : tr("Ctrl+{0} stores the current view as {0}").replace(/\{0\}/g, n);
    b.onclick = () => { recallView(n); $("#view-pop").classList.add("hidden"); };
    box.append(b);
  }
}
$("#btn-view").addEventListener("click", renderViewButtons);
$("#btn-whole").addEventListener("click", () => { viewWholeMap(); $("#view-pop").classList.add("hidden"); });
// a small cross in the middle of the view (option)
function applyCrosshair() { $("#crosshair").classList.toggle("hidden", !options.crosshair); }

// ---------- selection: back to the previous one (U), thin out, jitter, same rotation/size ----------
var selHistory = [], selRestoring = false;
function rememberSelection(objs) {
  if (selRestoring || !objs.length) return;
  const last = selHistory[selHistory.length - 1];
  if (last && last.length === objs.length && last.every((o, i) => o === objs[i])) return;
  selHistory.push(objs.slice());
  if (selHistory.length > 20) selHistory.shift();
}
function previousSelection() {
  selHistory.pop();  // the current one
  let prev = selHistory.pop();
  // skip selections whose objects are gone (deleted or undone)
  while (prev && !prev.some((o) => o.parent === root)) prev = selHistory.pop();
  if (!prev) return setStatus(tr("No earlier selection"));
  selRestoring = true;
  select(prev.filter((o) => o.parent === root));
  selRestoring = false;
  rememberSelection(selection);
  setStatus(tr("Earlier selection: {0} object(s)").replace("{0}", selection.length));
}
function thinOut() {
  if (selection.length < 2) return;
  const keep = selection.filter(() => Math.random() < 0.5);
  select(keep.length ? keep : [selection[0]]);
  setStatus(tr("Every second object kept at random: {0} selected").replace("{0}", selection.length));
}
function jitter() {
  const r = +$("#snap-t").value > 1 ? +$("#snap-t").value : 2;
  return transformSelection((o) => { o.position.x += (Math.random() * 2 - 1) * r; o.position.z += (Math.random() * 2 - 1) * r; },
    tr("Positions shifted at random (up to {0} units)").replace("{0}", r));
}
function sameRotation() {
  const p = primary();
  return transformSelection((o) => o.quaternion.copy(p.quaternion), tr("Same rotation as the last picked object"));
}
function sameSize() {
  const p = primary();
  return transformSelection((o) => o.scale.copy(p.scale), tr("Same size as the last picked object"));
}
// copy the rotation and size of one object onto others
var transformClip = null;
function copyTransform() {
  const p = primary();
  if (!p) return;
  transformClip = { q: p.quaternion.clone(), s: p.scale.clone() };
  setStatus(tr("Rotation and size copied"));
}
function pasteTransform() {
  if (!transformClip) return setStatus(tr("Copy the rotation and size of an object first"));
  return transformSelection((o) => { o.quaternion.copy(transformClip.q); o.scale.copy(transformClip.s); }, tr("Rotation and size pasted"));
}
// names of copies: name_2, name_3 ... instead of name_copy_copy
function copyName(name) {
  const base = name.replace(/(_copy)+$/, "").replace(/_\d+$/, "");
  const used = new Set(doc.entities.map((e) => e.name));
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}
// Ctrl+D again after moving a copy: the next copy goes the same way
var lastDup = null;
function duplicateOffset() {
  if (!lastDup || lastDup.copies.length !== selection.length || !lastDup.copies.every((o, i) => o === selection[i])) return null;
  const d = lastDup.copies[0].position.clone().sub(lastDup.from[0]);
  return d.lengthSq() > 0.0001 ? d : null;
}

// ---------- arrow keys along the view (option): up moves away from the camera ----------
function viewNudge(key, d) {
  const f = new THREE.Vector3().subVectors(orbit.target, camera.position).setY(0).normalize();
  if (!f.lengthSq()) f.set(0, 0, -1);
  // the larger axis of the view direction, so moves stay on the grid
  const fwd = Math.abs(f.x) > Math.abs(f.z) ? new THREE.Vector3(Math.sign(f.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(f.z));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const v = key === "ArrowUp" ? fwd : key === "ArrowDown" ? fwd.clone().negate() : key === "ArrowRight" ? right : right.clone().negate();
  return nudge(v.x * d, 0, v.z * d);
}

// ---------- the model preview: light background, triangles ----------
$("#preview-bg").addEventListener("click", () => {
  const light = !previewScene.userData.light;
  previewScene.userData.light = light;
  previewScene.background = new THREE.Color(light ? 0xb8b2a6 : 0x0c0b09);
  localStorage.setItem("previewLight", light ? "1" : "0");
});
if (localStorage.getItem("previewLight") === "1") $("#preview-bg").click();
function triangles(obj) {
  let n = 0;
  obj.traverse((o) => { if (o.isMesh && o.geometry) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return Math.round(n);
}

// ---------- the status bar: project and selection are clickable ----------
$("#proj-info").addEventListener("click", () => { document.querySelector('.tab[data-tab="presets"]')?.click(); $("#project-select")?.focus(); });
$("#sel-info").addEventListener("click", () => $("#props").scrollIntoView({ block: "start" }));
// errors in red
function markStatusError(t) {
  statusEl.classList.toggle("error", /\b(error|failed|fehler|fehlgeschlagen)\b/i.test(String(t)));
}

// ---------- the light symbols take the colour of their light ----------
function tintLightMarkers() {
  if (!root) return;
  for (const o of entityObjects.values()) {
    const lc = (o.userData.entity?.components || []).find((c) => /LightDefinitionComponent$/.test(c.type));
    const marker = o.children.find((c) => c.userData.helper);
    if (lc && marker && lc.color) marker.material.color.setRGB(lc.color.x ?? 1, lc.color.y ?? 1, lc.color.z ?? 1);
  }
}

// ---------- the map can be reloaded as saved (unsaved changes are dropped) ----------
$("#btn-revert").addEventListener("click", async () => {
  if (!presetPath) return;
  if (dirty && !confirm(tr("Drop the unsaved changes of this map and load it as saved?"))) return;
  dirty = false;
  await postJSON("draft", { path: presetPath });  // no draft either
  openPreset(presetPath);
});

// ---------- the export dialog remembers the zip switch ----------
$("#ex-zip").checked = localStorage.getItem("exZip") === "1";
$("#ex-zip").addEventListener("change", () => localStorage.setItem("exZip", $("#ex-zip").checked ? "1" : "0"));

// ---------- options to a file and back ----------
$("#opt-save").addEventListener("click", () => {
  const data = { options, keyMap, snap: ["snap-t", "snap-r", "snap-s"].map((id) => $("#" + id).value) };
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" })), download: "d2r-editor-options.json" });
  a.click();
  setStatus(tr("Options saved as d2r-editor-options.json (downloads folder)"));
});
$("#opt-load").addEventListener("click", () => $("#opt-file").click());
$("#opt-file").addEventListener("change", async () => {
  const f = $("#opt-file").files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    Object.assign(options, data.options || {});
    localStorage.setItem("options", JSON.stringify(options));
    if (data.keyMap) { keyMap = data.keyMap; localStorage.setItem("keyMap", JSON.stringify(keyMap)); }
    (data.snap || []).forEach((v, i) => { $("#" + ["snap-t", "snap-r", "snap-s"][i]).value = v; });
    applySnap();
    applyOptions();
    renderOptions();
    setStatus(tr("Options loaded"));
  } catch { setStatus(tr("This is not an options file of the editor")); }
  $("#opt-file").value = "";
});

// ---------- the message window can be copied ----------
$("#modal-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#modal-body").textContent); setStatus(tr("Copied to the clipboard")); } catch { setStatus(tr("The clipboard could not be used")); }
});

// ---------- after the editor program was updated, the page asks to be reloaded ----------
var pageVersion = null;
fetch(api("version")).then((r) => r.json()).then((v) => { pageVersion = JSON.stringify(v); }).catch(() => {});
async function checkVersionAfterReconnect() {
  try {
    const v = JSON.stringify(await (await fetch(api("version"))).json());
    if (pageVersion && v !== pageVersion) {
      const bar = $("#offline");
      bar.textContent = tr("The editor program was updated: reload the page (F5) to use the new version.");
      bar.classList.remove("hidden");
    }
  } catch { /* still starting */ }
}

// ---------- kits: replace a kit's content with the selection ----------
$("#kit-update").addEventListener("click", () => {
  if (!kitSel) return setStatus(tr("Choose a kit in the list first"));
  if (!selection.length) return setStatus(tr("Select the objects of the kit first"));
  if (confirm(tr("Replace the kit {0} with the {1} selected object(s)?").replace("{0}", kitSel).replace("{1}", selection.length))) saveKit(kitSel);
});

// ---------- objects list: hide everything it shows ----------
$("#object-hide-all").addEventListener("click", () => {
  const ids = [...document.querySelectorAll("#object-list li[data-id]")].map((li) => li.dataset.id);
  let n = 0;
  for (const id of ids) {
    const o = entityObjects.get(isNaN(+id) ? id : +id) || entityObjects.get(id);
    if (!o || o.userData.terrain || !o.visible) continue;
    o.visible = false;
    hiddenIds.add(o.userData.entity.id);
    n++;
  }
  if (selection.some((o) => !o.visible)) select(selection.filter((o) => o.visible));
  renderObjectList();
  setStatus(tr("{0} object(s) hidden · Shift+H shows them again").replace("{0}", hiddenIds.size));
});

// ---------- Ctrl+F: the search field of the open tab on the left ----------
function focusSearch() {
  const pane = [...document.querySelectorAll(".pane")].find((p) => !p.classList.contains("hidden"));
  const field = pane?.querySelector("input[type=text], input:not([type]), input[type=search]");
  if (field) { field.focus(); field.select(); }
}

// ---------- the mouse wheel over the snap fields steps through useful values ----------
const SNAP_STEPS = { "snap-t": [0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20], "snap-r": [1, 5, 10, 15, 22.5, 30, 45, 90], "snap-s": [0.01, 0.05, 0.1, 0.25, 0.5] };
for (const [id, steps] of Object.entries(SNAP_STEPS)) {
  $("#" + id).addEventListener("wheel", (e) => {
    e.preventDefault();
    const v = +$("#" + id).value;
    let i = steps.findIndex((s) => s >= v - 1e-9);
    if (i < 0) i = steps.length - 1;
    i = Math.max(0, Math.min(steps.length - 1, i + (e.deltaY < 0 ? 1 : -1)));
    $("#" + id).value = steps[i];
    applySnap();
  }, { passive: false });
}

// ---------- Ctrl+click on a model in the list: favourite or not ----------
function toggleFavModel(m) {
  const list = favModels();
  const on = list.includes(m);
  localStorage.setItem("favModels", JSON.stringify(on ? list.filter((x) => x !== m) : [m, ...list]));
  updateFavButton();
  setStatus(on ? tr("Removed from the favourites") : tr("Added to the favourites"));
}

// ---------- the recently opened maps can be cleared ----------
function clearRecentMaps() {
  localStorage.removeItem("recentMaps");
  renderPresets();
  countMaps();
}
