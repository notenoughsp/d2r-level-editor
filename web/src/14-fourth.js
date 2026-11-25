// State in this part is `var`: earlier parts may call these functions while the page starts.

// ---------- smooth camera flights (flyTo moves the camera over a short moment) ----------
var camAnim = null;
function startCameraAnim(toTarget, toPos) {
  camAnim = { t: 0, fromT: orbit.target.clone(), fromP: camera.position.clone(), toT: toTarget.clone(), toP: toPos.clone() };
}
function updateCameraAnim(dt) {
  if (!camAnim) return;
  camAnim.t = Math.min(1, camAnim.t + dt / 0.35);
  const s = camAnim.t * camAnim.t * (3 - 2 * camAnim.t);
  orbit.target.lerpVectors(camAnim.fromT, camAnim.toT, s);
  camera.position.lerpVectors(camAnim.fromP, camAnim.toP, s);
  if (camAnim.t >= 1) camAnim = null;
}

// ---------- number pad: 4/6 turn the view by 45°, 8/2 tilt it, 5 top view ----------
function turnView(dAz, dPolar) {
  camAnim = null;
  const off = camera.position.clone().sub(orbit.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.theta += dAz;
  sph.phi = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, sph.phi + dPolar));
  camera.position.copy(orbit.target).add(new THREE.Vector3().setFromSpherical(sph));
  orbit.update();
}

// ---------- Space: move, rotate, scale in turn ----------
function cycleMode() {
  const order = ["translate", "rotate", "scale"];
  setMode(order[(order.indexOf(gizmo.getMode()) + 1) % 3]);
}

// ---------- I: only the selection is shown (again I: all) ----------
var isolated = null;
function toggleIsolate() {
  if (isolated) {
    for (const o of isolated) if (!hiddenIds.has(o.userData.entity.id)) o.visible = true;
    isolated = null;
    return setStatus(tr("All objects shown again"));
  }
  if (!selection.length) return setStatus(tr("Select the objects to look at alone first"));
  const keep = new Set(selection);
  isolated = [...entityObjects.values()].filter((o) => !o.userData.terrain && o.visible && !keep.has(o));
  for (const o of isolated) o.visible = false;
  setStatus(tr("Only the selection is shown · I shows all again"));
}

// ---------- wireframe view (View menu) ----------
function applyWireframe() {
  const on = $("#wireframe").checked;
  if (!root) return;
  root.traverse((o) => {
    // helper symbols and placeholders are wire frames anyway; the ground stays solid
    if (!o.isMesh || o.userData.helper || o.userData.placeholder || o.userData.terrain || o.parent?.userData.terrain) return;
    for (const m of [].concat(o.material)) if (m && "wireframe" in m && !m.userData.keepWire) m.wireframe = on;
  });
}
$("#wireframe").addEventListener("change", () => { applyWireframe(); localStorage.setItem("view:wireframe", $("#wireframe").checked ? "1" : "0"); });
$("#wireframe").checked = localStorage.getItem("view:wireframe") === "1";

// ---------- J: the next object with the same model ----------
function nextSameModel() {
  const p = primary();
  const md = p && comp(p.userData.entity, "ModelDefinitionComponent");
  if (!md) return setStatus(tr("Select an object with a model first"));
  const same = [...entityObjects.values()].filter((o) => o.visible && pickable(o) && comp(o.userData.entity, "ModelDefinitionComponent")?.filename === md.filename);
  const next = same[(same.indexOf(p) + 1) % same.length];
  select([next]);
  flyTo(next.getWorldPosition(new THREE.Vector3()));
  setStatus(tr("{0} of {1} with this model").replace("{0}", same.indexOf(next) + 1).replace("{1}", same.length));
}

// ---------- Shift+T: top view right above the selection ----------
function topViewOnSelection() {
  if (selection.length) {
    const c = new THREE.Box3().setFromPoints(selection.map((o) => o.getWorldPosition(new THREE.Vector3()))).getCenter(new THREE.Vector3());
    camAnim = null;
    camera.position.add(c.clone().sub(orbit.target));
    orbit.target.copy(c);
  }
  toggleTopView();
}

// ---------- while dragging a handle: how far, how much turned or scaled (status line, not kept) ----------
function showDragAmount() {
  const p = primary();
  const start = dragStart?.objs.find(([o]) => o === p)?.[1];
  if (!p || !start) return;
  const sp = new THREE.Vector3(), sq = new THREE.Quaternion(), ss = new THREE.Vector3();
  start.decompose(sp, sq, ss);
  const mode = gizmo.getMode();
  let text;
  if (mode === "rotate") text = `⟳ ${THREE.MathUtils.radToDeg(sq.angleTo(p.quaternion)).toFixed(1)}°`;
  else if (mode === "scale") text = `× ${(p.scale.x / (ss.x || 1)).toFixed(2)}`;
  else {
    const d = p.position.clone().sub(sp);
    text = `Δ ${d.length().toFixed(2)}  (x ${d.x.toFixed(2)}  y ${d.y.toFixed(2)}  z ${d.z.toFixed(2)})  ·  ${(Math.hypot(d.x, d.z) / 10).toFixed(2)} ${tr("tiles")}`;
  }
  statusEl.textContent = text;
  statusEl.classList.remove("old");
}

// ---------- light colours in one click ----------
const LIGHT_PRESETS = [["Torch", [1, 0.62, 0.3]], ["Fire", [1, 0.42, 0.12]], ["Moonlight", [0.55, 0.66, 1]], ["Magic", [0.62, 0.32, 1]], ["Poison", [0.45, 1, 0.35]], ["White", [1, 1, 1]]];
function lightPresetButtons() {
  return `<div class="light-presets">` + LIGHT_PRESETS.map(([n, c], i) =>
    `<button data-lpreset="${i}" title="${tr(n)}" style="background:rgb(${c.map((v) => Math.round(v * 255)).join(",")})"></button>`).join("") + "</div>";
}
function wireLightPresets(lc) {
  document.querySelectorAll("[data-lpreset]").forEach((b) => b.addEventListener("click", () => {
    const [name, [x, y, z]] = LIGHT_PRESETS[+b.dataset.lpreset];
    beginEdit();
    lc.color = { x, y, z };
    if ($("#lt-color")) $("#lt-color").value = toHex(lc.color);
    markDirty();
    lightTick = 0;
    setStatus(tr("Light colour: {0}").replace("{0}", tr(name)));
  }));
}

// ---------- screenshot into the clipboard (Shift+click on Screenshot) ----------
async function screenshotToClipboard(url) {
  try {
    const blob = await (await fetch(url)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setStatus(tr("Screenshot copied to the clipboard"));
  } catch { setStatus(tr("The clipboard could not be used")); }
}

// ---------- the game's mods folder from the export dialog ----------
$("#ex-mods-folder").addEventListener("click", async () => {
  const r = await postJSON("reveal", { what: "mods" });
  if (!r.ok) setStatus(r.data.error);
});

// ---------- the maps list: right click copies the map's path ----------
$("#preset-list").addEventListener("contextmenu", async (e) => {
  const li = e.target.closest("li[title]");
  if (!li || !li.title.startsWith("data/")) return;
  e.preventDefault();
  try { await navigator.clipboard.writeText(li.title); setStatus(tr("Copied: {0}").replace("{0}", li.title)); } catch { /* no clipboard */ }
});

// ---------- the last added game object kind is remembered ----------
function restoreAddObject() {
  const s = JSON.parse(localStorage.getItem("addObject") || "null");
  if (!s) return fillAddObjectList();
  $("#add-obj-type").value = s.type;
  $("#add-obj-filter").value = s.filter || "";
  fillAddObjectList();
  if ([...$("#add-obj-id").options].some((o) => o.value === s.id)) $("#add-obj-id").value = s.id;
}
for (const id of ["add-obj-type", "add-obj-filter", "add-obj-id"]) $("#" + id).addEventListener("change", () =>
  localStorage.setItem("addObject", JSON.stringify({ type: $("#add-obj-type").value, filter: $("#add-obj-filter").value, id: $("#add-obj-id").value })));
