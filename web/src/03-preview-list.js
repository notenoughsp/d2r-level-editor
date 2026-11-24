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
  $("#usage-btn").disabled = false;
  $("#usage-box").classList.add("hidden");
  if (options.animations && await previewCharacter(path, token)) return;
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
let previewLast = performance.now();
function renderPreview() {
  const now = performance.now(), dt = Math.min(0.1, (now - previewLast) / 1000);
  previewLast = now;
  const w = previewCanvas.clientWidth, h = previewCanvas.clientHeight;
  if (w && (previewCanvas.width !== w || previewCanvas.height !== h)) {
    previewRenderer.setSize(w, h, false);
    previewCamera.aspect = w / h;
    previewCamera.updateProjectionMatrix();
  }
  if (previewObj && !previewDrag && options.previewSpin && now - previewTouched > 3000) previewObj.rotation.y += 0.6 * dt;
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

// the mod's folder name: the one of the export dialog (mod info), asked once more
async function askModName() {
  const info = await (await fetch(api("modinfo"))).json();
  return prompt("Mod name (folder under mods\\):", info.name || "D2REditor");
}

async function startTest() {
  if (dirty && !confirm("The current map has unsaved changes. Save first?")) return;
  if (dirty) await save();
  const name = await askModName();
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
  // kinds with their counts, and the chosen kind and order
  const kinds = new Map();
  for (const ent of doc.entities) { const k = kindOf(ent)[1]; kinds.set(k, (kinds.get(k) || 0) + 1); }
  const ks = $("#object-kind"), want = ks.value;
  ks.textContent = "";
  ks.append(new Option(tr("All kinds ({0})").replace("{0}", doc.entities.length), ""));
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) ks.append(new Option(`${tr(k)} (${n})`, k));
  ks.value = kinds.has(want) ? want : "";
  const order = $("#object-sort").value;
  let list = doc.entities.filter((e) => !ks.value || kindOf(e)[1] === ks.value);
  if (order === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  else if (order === "kind") list = [...list].sort((a, b) => kindOf(a)[1].localeCompare(kindOf(b)[1]) || a.name.localeCompare(b.name));
  for (const ent of list) {
    const [icon, kind] = kindOf(ent);
    // the kind can be searched in the shown language too (e.g. "Licht" for lights)
    if (f && !ent.name.toLowerCase().includes(f) && !kind.toLowerCase().includes(f) && !tr(kind).toLowerCase().includes(f)) continue;
    if (shown >= options.maxListEntries) { shown += 1; continue; }  // the list is capped, the count stays right
    shown += 1;
    const li = document.createElement("li");
    li.innerHTML = `<span class="kind" title="${kind}">${icon}</span>`;
    li.appendChild(marked(ent.name, f));
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
  $("#object-count").textContent = f || ks.value ? `${doc.entities.length} objects, ${shown} matching` : `${doc.entities.length} objects`;
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
$("#object-kind").addEventListener("change", renderObjectList);
$("#object-sort").addEventListener("change", () => { localStorage.setItem("objectSort", $("#object-sort").value); renderObjectList(); });
$("#object-sort").value = localStorage.getItem("objectSort") || "map";
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
    // plain information goes away by itself after a while; warnings stay until closed
    clearTimeout(showPresetInfo.timer);
    if (banner.className === "info") showPresetInfo.timer = setTimeout(() => banner.classList.add("hidden"), 9000);
  } catch { /* info is optional */ }
}
