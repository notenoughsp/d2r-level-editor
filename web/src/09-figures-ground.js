// ---------- animated characters (tools/anim_export.py: skeleton, skinning, animations) ----------
const charCache = new Map();
function loadCharacter(ref) {
  if (!charCache.has(ref)) {
    charCache.set(ref, trackLoad(new Promise((ok) => loader.load(api("character", { ref, lod: 1, v: 2 }), (g) => {
      g.scene.traverse((o) => { if (o.isMesh && o.material && o.material.map) o.material.map.colorSpace = THREE.SRGBColorSpace; });
      ok(g);
    }, undefined, () => ok(null)))));
  }
  return charCache.get(ref);
}
const mixers = new Set();
const animClock = new THREE.Clock();
function animate(gltf, wanted) {
  const obj = cloneSkinned(gltf.scene);
  obj.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  const mixer = new THREE.AnimationMixer(obj);
  const clips = gltf.animations || [];
  const pick = (name) => clips.find((c) => c.name === name);
  const clip = pick(wanted) || pick("neutral") || clips.find((c) => /idle|neutral|stand/i.test(c.name)) || clips[0];
  if (clip) mixer.clipAction(clip).play();
  obj.userData.mixer = mixer;
  obj.userData.clips = clips;
  mixers.add(mixer);
  return obj;
}
function charRefOf(path) {
  const m = /data\/hd\/character\/[^/]+\/([^/]+)\//.exec(path || "");
  return m ? m[1] : null;
}
function updateMixers() {
  const dt = Math.min(0.1, animClock.getDelta());
  updateWalkers(dt);
  for (const m of mixers) {
    let top = m.getRoot();
    while (top.parent) top = top.parent;
    if (top !== scene && top !== previewScene) { mixers.delete(m); continue; }
    if (options.animations) m.update(dt);
  }
}
// the preview plays the character's animations; a list chooses which
async function previewCharacter(path, token) {
  const ref = charRefOf(path);
  const sel = $("#anim-select");
  sel.classList.add("hidden");
  if (!ref) return false;
  const g = await loadCharacter(ref);
  if (!g || token !== previewToken || !(g.animations || []).length) return false;
  const show = (name) => {
    if (previewObj) previewScene.remove(previewObj);
    previewObj = new THREE.Group();
    const inner = animate(g, name);
    previewObj.add(inner);
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    inner.position.sub(box.getCenter(new THREE.Vector3()));
    previewScene.add(previewObj);
    const r = Math.max(size.x, size.y, size.z) || 1;
    previewCamera.position.set(0, r * 0.4, r * 1.8).multiplyScalar(previewZoom);
    previewCamera.lookAt(0, 0, 0);
    $("#preview-info").textContent = `${ref} · ${tr("animated")} · ${size.y.toFixed(1)} ${tr("high")}`;
  };
  sel.textContent = "";
  for (const c of g.animations) sel.append(new Option(c.name, c.name));
  sel.value = (g.animations.find((c) => c.name === "neutral") || g.animations[0]).name;
  sel.onchange = () => show(sel.value);
  sel.classList.remove("hidden");
  show(sel.value);
  return true;
}

// ---------- NPC figures walk their paths (view only) ----------
const walkers = new Set();
function startWalker(g, fig, label, ob) {
  const clips = fig.userData.clips || [];
  const walk = clips.find((c) => /^walk/i.test(c.name)), idle = clips.find((c) => c.name === "neutral") || clips[0];
  if (!walk) return;
  const pts = [[ob.x, ob.y], ...ob.path.map((p) => [p[0], p[1]])].map(([x, y]) => {
    const wx = x * 2 + 1, wz = y * 2 + 1;
    return new THREE.Vector3(wx - g.position.x, groundHeight(wx, wz) - g.position.y, wz - g.position.z);
  });
  pts.push(pts[0].clone());  // back to the start
  const mixer = fig.userData.mixer;
  const aWalk = mixer.clipAction(walk), aIdle = idle ? mixer.clipAction(idle) : null;
  fig.userData.walk = { pts, seg: 0, wait: 1 + Math.random() * 2, aWalk, aIdle, label, base: fig.position.y };
  walkers.add(fig);
}
function updateWalkers(dt) {
  for (const fig of walkers) {
    let top = fig;
    while (top.parent) top = top.parent;
    if (top !== scene) { walkers.delete(fig); continue; }
    const w = fig.userData.walk;
    if (!options.walkPaths || w.paused) continue;
    if (w.wait > 0) {  // standing at a point
      w.wait -= dt;
      if (w.aIdle && !w.aIdle.isRunning()) { w.aWalk.stop(); w.aIdle.play(); }
      continue;
    }
    if (!w.aWalk.isRunning()) { if (w.aIdle) w.aIdle.stop(); w.aWalk.play(); }
    const to = w.pts[w.seg + 1];
    const d = new THREE.Vector3(to.x - fig.position.x, 0, to.z - fig.position.z);
    const len = d.length(), step = 3.2 * dt * options.figureScale;
    if (len <= step) {
      fig.position.x = to.x; fig.position.z = to.z;
      w.seg = (w.seg + 1) % (w.pts.length - 1);
      if (w.seg === 0) { fig.position.x = w.pts[0].x; fig.position.z = w.pts[0].z; }
      w.wait = 0.8 + Math.random() * 2.5;
    } else {
      d.multiplyScalar(step / len);
      fig.position.x += d.x; fig.position.z += d.z;
      fig.rotation.y = Math.atan2(d.x, d.z);
    }
    if (w.label) { w.label.position.x = fig.position.x; w.label.position.z = fig.position.z; }
  }
}

// ---------- decorate: plants, rocks and small things of this map around the cursor ----------
const DECOR = /foliage|plant|bush|shrub|grass|fern|flower|weed|rock|stone|pebble|boulder|debris|rubble|twig|branch|log|leaves|mushroom|bones|skull/i;
// things that hang, climb or are big (trees) do not belong on open ground
const NOT_DECOR = /hanging|climbing|ivy|vine|roots|tree|wall|canopy|cliff|bridge|fence|house|tent/i;
function mapDecor() {
  const count = new Map();
  for (const ent of doc.entities) {
    const md = comp(ent, "ModelDefinitionComponent");
    if (!md || !md.filename || comp(ent, "TerrainDefinitionComponent") || !DECOR.test(md.filename) || NOT_DECOR.test(md.filename)) continue;
    count.set(md.filename, (count.get(md.filename) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
}
async function decorate(center) {
  if (!doc) return alert("Open a map first.");
  const pool = mapDecor();
  if (!pool.length) return setStatus(tr("This map has no plants or rocks to take as decoration; use Scatter with a model instead"));
  const o = scatterSettings(), c = center || orbit.target;
  const total = pool.reduce((s, [, n]) => s + n, 0);
  beginEdit();
  const made = [];
  for (let i = 0; i < o.count; i++) {
    let r = Math.random() * total, model = pool[0][0];
    for (const [m, n] of pool) { r -= n; if (r <= 0) { model = m; break; } }  // as often as on the map
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * o.radius;
    const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
    const s = o.smin + Math.random() * (o.smax - o.smin);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    const ent = modelEntity(model, { x, y: groundHeight(x, z), z }, q, s, `_${i}`);
    doc.entities.push(ent);
    made.push(addObjectFor(ent));
  }
  select(await Promise.all(made));
  markDirty();
  setStatus(tr("{0} decoration objects from {1} kinds of this map").replace("{0}", o.count).replace("{1}", pool.length));
}
$("#sc-decor").addEventListener("click", () => decorate(null));

// ---------- paths and rivers: click points, Enter lays ground stamps along the line ----------
let stampPath = null;
function toggleStampPath() {
  if (stampPath) return endStampPath(false);
  if (!doc || !$("#st-mask").value) return setStatus(tr("Open a map and choose a mask first"));
  stampPath = { pts: [], line: null };
  $("#st-path").classList.add("active");
  setStatus(tr("Path: click points on the ground · Backspace: remove the last · Enter: lay the stamps · Esc: cancel"));
}
function drawStampPath() {
  if (stampPath.line) { scene.remove(stampPath.line); stampPath.line.geometry.dispose(); }
  const pts = stampPath.pts.map((p) => new THREE.Vector3(p.x, groundHeight(p.x, p.z) + 0.5, p.z));
  stampPath.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x6fd3ff, depthTest: false }));
  stampPath.line.renderOrder = 22;
  scene.add(stampPath.line);
}
async function endStampPath(lay) {
  const p = stampPath;
  stampPath = null;
  $("#st-path").classList.remove("active");
  if (p.line) { scene.remove(p.line); p.line.geometry.dispose(); }
  if (!lay || p.pts.length < 2) return setStatus(tr("Path cancelled"));
  const size = Math.max(2, +$("#st-size").value || 20), spacing = size * 0.45;
  beginEdit();
  const made = [];
  for (let i = 0; i < p.pts.length - 1; i++) {
    const a = p.pts[i], b = p.pts[i + 1], len = a.distanceTo(b), n = Math.max(1, Math.ceil(len / spacing));
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    for (let k = 0; k < n; k++) {
      const at = a.clone().lerp(b, k / n);
      const obj = await placeStamp(at, yaw);
      made.push(obj);
    }
  }
  made.push(await placeStamp(p.pts[p.pts.length - 1], 0));
  markDirty();
  setStatus(tr("Path laid: {0} ground stamps").replace("{0}", made.length));
}
renderer.domElement.addEventListener("pointerdown", (e) => { if (stampPath && e.button === 0) e.stopImmediatePropagation(); }, true);
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!stampPath || e.button !== 0 || !cursorGround) return;
  e.stopImmediatePropagation();
  stampPath.pts.push(cursorGround.clone());
  drawStampPath();
}, true);
window.addEventListener("keydown", (e) => {
  if (!stampPath) return;
  if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); endStampPath(true); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); endStampPath(false); }
  else if (e.key === "Backspace") { e.preventDefault(); e.stopImmediatePropagation(); stampPath.pts.pop(); drawStampPath(); }
}, true);
$("#st-path").addEventListener("click", toggleStampPath);

// ---------- projects as one file: save to share or move, load as a new project ----------
$("#project-save").addEventListener("click", () => {
  const a = Object.assign(document.createElement("a"), { href: api("project/file"), download: "" });
  document.body.append(a); a.click(); a.remove();
  setStatus(tr("Project file saved (downloads folder)"));
});
$("#project-load").addEventListener("click", () => $("#project-file").click());
$("#project-file").addEventListener("change", async () => {
  const f = await readFile($("#project-file"));
  $("#project-file").value = "";
  if (!f) return;
  const name = prompt("Name of the loaded project:", f.name.replace(/\.d2rproject\.zip$|\.zip$/i, "").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 40) || "Shared");
  if (!name) return;
  if (dirty && !confirm("Discard unsaved changes?")) return;
  const r = await postJSON("project/import", {}, { name, data: f.data });
  if (!r.ok) return setStatus(tr("Project not loaded: {0}").replace("{0}", r.data.error));
  dirty = false;
  location.reload();
});

// ---------- start where you left off: the last map and the last tab on the left ----------
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => localStorage.setItem("leftTab", b.dataset.tab)));
(async () => {
  const tab = localStorage.getItem("leftTab");
  const btn = tab && document.querySelector(`.tab[data-tab="${tab}"]`);
  if (btn && tab !== "presets") btn.click();
  if (!options.reopen) return;
  for (let i = 0; i < 50 && !presets.length; i++) await new Promise((r) => setTimeout(r, 200));
  const last = recentMaps()[0];
  if (last && presets.includes(last) && !presetPath) openPreset(last);
})();

// ---------- a selected NPC figure: a box around it, and its animations ----------
let gameSelBox = null;
function figureOf(g) { return g ? g.children.find((c) => c.userData.figure) : null; }
function markFigure(g) {
  if (gameSelBox) { scene.remove(gameSelBox); gameSelBox.geometry.dispose(); gameSelBox = null; }
  const fig = figureOf(g);
  if (!fig) return;
  gameSelBox = new THREE.BoxHelper(fig, options.selColor);
  scene.add(gameSelBox);
}
function figureProps(g) {
  const fig = figureOf(g);
  if (!fig || !(fig.userData.clips || []).length) return;
  const row = document.createElement("div");
  row.className = "prop-row light-row";
  const lab = document.createElement("span");
  lab.textContent = tr("Animation");
  const sel = document.createElement("select");
  sel.append(new Option(tr("(walks its path / stands)"), ""));
  for (const c of fig.userData.clips) sel.append(new Option(c.name, c.name));
  sel.value = fig.userData.chosen || "";
  sel.addEventListener("change", () => {
    const mixer = fig.userData.mixer;
    mixer.stopAllAction();
    fig.userData.chosen = sel.value;
    if (fig.userData.walk) fig.userData.walk.paused = !!sel.value;
    const clip = fig.userData.clips.find((c) => c.name === sel.value) || fig.userData.clips.find((c) => c.name === "neutral") || fig.userData.clips[0];
    mixer.clipAction(clip).play();
  });
  row.append(lab, sel);
  $("#props").insertBefore(row, $("#props").querySelector(".prop-buttons"));
}

// ---------- double-click in the view: fly to the object there ----------
renderer.domElement.addEventListener("dblclick", (e) => {
  if (tool !== "objects" || !root || measuring || brushOn || stampOn) return;
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  let hit = null;
  for (const h of raycaster.intersectObject(root, true)) {
    let o = h.object;
    while (o && !o.userData.entity) o = o.parent;
    if (o && o.parent === root && !o.userData.terrain && o.visible) { hit = h; break; }
  }
  const target = hit ? hit.point : cursorGround;
  if (target) flyTo(target);
});
// the camera looks at a point from the same direction, at most 40 units away
function flyTo(target) {
  const dir = camera.position.clone().sub(orbit.target).normalize();
  const dist = Math.min(camera.position.distanceTo(orbit.target), 40);
  orbit.target.copy(target);
  camera.position.copy(target).addScaledVector(dir, dist);
  orbit.update();
}
