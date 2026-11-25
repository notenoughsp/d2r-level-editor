// ---------- options window (stored in the browser, applied at once) ----------
const OPTION_DEFAULTS = {
  uiScale: 100, fov: 45, rotateSpeed: 1, zoomSpeed: 1, panSpeed: 1, damping: false, showGrid: true, gridStep: 5,
  autosave: 60, undoSteps: 100, labels: true, labelScale: 0.6, hoverInfo: true, previewSpin: true, statusFade: 8,
  confirmDelete: 20, dupOffset: 2, minimapSize: 220, renderScale: 100, selColor: "#ffd400", bg: "", checkUpdates: true,
  maxListEntries: 1500, tooltips: true, thumbs: true, effects: true, stamps: true, animations: true, figures: true, figureScale: 1, walkPaths: true, reopen: true, zoomToCursor: true,
};
let options = { ...OPTION_DEFAULTS, ...JSON.parse(localStorage.getItem("options") || "{}") };
if (!options.v2) { options.damping = false; options.v2 = true; localStorage.setItem("options", JSON.stringify(options)); }  // smoothing off since 0.5.1
if (!options.v3) { if (options.labelScale === 1) options.labelScale = 0.6; options.v3 = true; localStorage.setItem("options", JSON.stringify(options)); }  // smaller names since 0.6
const OPTION_FORM = [
  ["Interface", [
    ["uiScale", "Size of the interface (%)", "number", 70, 160, 5],
    ["tooltips", "Show tooltips", "check"],
    ["statusFade", "Status messages fade after (s, 0 = never)", "number", 0, 120, 1],
    ["hoverInfo", "Name of the object under the mouse in the status bar", "check"],
    ["maxListEntries", "Entries shown in the objects list", "number", 100, 20000, 100],
    ["checkUpdates", "Look for updates at start", "check"],
    ["reopen", "Open the last map at start", "check"],
    ["thumbs", "Pictures in the model list", "check"],
  ]],
  ["Camera and view", [
    ["fov", "Field of view (degrees)", "number", 20, 100, 1],
    ["rotateSpeed", "Turn speed", "number", 0.1, 5, 0.1],
    ["zoomSpeed", "Zoom speed", "number", 0.1, 5, 0.1],
    ["panSpeed", "Pan speed", "number", 0.1, 5, 0.1],
    ["damping", "Smooth camera movement", "check"],
    ["zoomToCursor", "Zoom towards the mouse cursor", "check"],
    ["renderScale", "Render resolution (%, lower = faster)", "number", 25, 200, 5],
    ["bg", "Background colour (empty = from the light)", "color"],
  ]],
  ["Grid and selection", [
    ["showGrid", "Show the grid", "check"],
    ["gridStep", "Grid line every (units, 10 = 1 tile)", "number", 1, 50, 1],
    ["selColor", "Colour of the selection box", "color"],
    ["dupOffset", "Offset of duplicates (units)", "number", 0, 50, 0.5],
    ["confirmDelete", "Ask before deleting more than (objects, 0 = never)", "number", 0, 10000, 1],
  ]],
  ["Game objects and labels", [
    ["labels", "Show names over game objects", "check"],
    ["labelScale", "Size of the names", "number", 0.3, 3, 0.1],
    ["effects", "Show effects (fire, smoke, fog, flies) as particles", "check"],
    ["stamps", "Show ground stamps with their ground layers (needs reopening the map)", "check"],
    ["animations", "Play character animations", "check"],
    ["figures", "Show NPCs and monsters as their figures (needs reopening the map)", "check"],
    ["figureScale", "Size of the figures", "number", 0.1, 5, 0.1],
    ["walkPaths", "NPC figures walk their paths", "check"],
  ]],
  ["Saving and undo", [
    ["autosave", "Autosave a draft every (s, 0 = off)", "number", 0, 3600, 10],
    ["undoSteps", "Undo steps kept", "number", 10, 1000, 10],
  ]],
  ["Previews and minimap", [
    ["previewSpin", "Turn the model preview by itself", "check"],
    ["minimapSize", "Size of the minimap (pixels)", "number", 100, 500, 10],
  ]],
];
let autosaveTimer = null;
function applyOptions() {
  document.body.style.zoom = options.uiScale / 100;
  camera.fov = options.fov; camera.updateProjectionMatrix();
  orbit.rotateSpeed = options.rotateSpeed; orbit.zoomSpeed = options.zoomSpeed; orbit.panSpeed = options.panSpeed;
  orbit.enableDamping = options.damping;
  orbit.zoomToCursor = options.zoomToCursor;
  grid.visible = options.showGrid;
  updateTileGrid();
  const div = Math.max(1, Math.round(1000 / options.gridStep));
  if (grid.userData.div !== div) {
    const g = new THREE.GridHelper(1000, div, 0x3a3326, 0x221f19);
    grid.geometry.dispose(); grid.geometry = g.geometry; grid.userData.div = div;
  }
  renderer.setPixelRatio(window.devicePixelRatio * options.renderScale / 100);
  resize();
  if (options.bg) scene.background.set(options.bg); else setLight(localStorage.getItem("light") || "day");
  for (const b of selectionBoxes) b.material.color.set(b === selectionBoxes[selectionBoxes.length - 1] ? options.selColor : 0xc7a35a);
  if (gameRoot) gameRoot.traverse((o) => { if (o.isSprite) { o.visible = options.labels; o.scale.set(o.userData.baseW * options.labelScale || o.scale.x, o.userData.baseH * options.labelScale || o.scale.y, 1); } });
  $("#hover-info").classList.toggle("hidden", !options.hoverInfo);
  document.body.classList.toggle("no-tips", !options.tooltips);
  clearInterval(autosaveTimer);
  if (options.autosave > 0) autosaveTimer = setInterval(async () => {
    if (!dirty || !doc || !presetPath) return;
    const r = await postJSON("draft", { path: presetPath }, doc);
    if (r.ok) setStatus(`Draft autosaved (${new Date().toLocaleTimeString(locale())})`);
  }, options.autosave * 1000);
}
function renderOptions() {
  const box = $("#opt-body");
  box.textContent = "";
  for (const [section, items] of OPTION_FORM) {
    const h = document.createElement("h4");
    h.textContent = tr(section);
    box.append(h);
    const grid2 = document.createElement("div");
    grid2.className = "opt-grid";
    for (const [key, label, kind, min, max, step] of items) {
      const l = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = tr(label);
      const inp = document.createElement("input");
      inp.dataset.opt = key;
      if (kind === "check") { inp.type = "checkbox"; inp.checked = !!options[key]; }
      else if (kind === "color") { inp.type = "color"; inp.value = options[key] || "#15130f"; }
      else Object.assign(inp, { type: "number", min, max, step, value: options[key] });
      inp.addEventListener("change", () => {
        options[key] = kind === "check" ? inp.checked : kind === "color" ? inp.value : Math.max(min, Math.min(max, +inp.value || OPTION_DEFAULTS[key]));
        localStorage.setItem("options", JSON.stringify(options));
        applyOptions();
      });
      l.append(span, inp);
      grid2.append(l);
    }
    box.append(grid2);
  }
  renderKeyOptions(box);
}

// ---------- own keyboard shortcuts: a key per action, translated to the built-in key ----------
const KEY_ACTIONS = [
  ["w", "Move"], ["e", "Rotate"], ["r", "Scale"], ["t", "Top view"], ["g", "Drop to ground"], ["f", "Focus the selection"],
  ["h", "Hide the selection"], ["p", "Place the preview model"], ["o", "Add a game object"], ["m", "Ruler"], ["n", "Minimap"],
  ["c", "Compare with the original"], ["l", "World or object axes"], ["q", "Objects tool"], ["b", "Collision: block"], ["x", "Collision: clear"],
];
let keyMap = JSON.parse(localStorage.getItem("keyMap") || "{}");  // built-in key -> own key
function translateKey(key) {
  const own = Object.entries(keyMap).find(([, k]) => k === key);
  if (own) return own[0];                       // an own key: do what its built-in key does
  if (keyMap[key] && keyMap[key] !== key) return null;  // a built-in key that was moved away
  return key;
}
function renderKeyOptions(box) {
  const h = document.createElement("h4");
  h.textContent = tr("Keyboard shortcuts");
  box.append(h);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = tr("Click a field and press a letter or digit key. Shift and Ctrl combinations stay as they are.");
  box.append(hint);
  const grid2 = document.createElement("div");
  grid2.className = "opt-grid";
  for (const [key, label] of KEY_ACTIONS) {
    const l = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = tr(label);
    const inp = Object.assign(document.createElement("input"), { value: (keyMap[key] || key).toUpperCase(), readOnly: true, className: "key-input" });
    inp.addEventListener("keydown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const k = ev.key.toLowerCase();
      if (ev.key === "Escape" || ev.key === "Tab") return;
      if (!/^[a-z0-9]$/.test(k)) return setStatus(tr("Only letters and digits"));
      const taken = KEY_ACTIONS.find(([b]) => b !== key && (keyMap[b] || b) === k);
      if (taken) return setStatus(tr("{0} is used by: {1}").replace("{0}", k.toUpperCase()).replace("{1}", tr(taken[1])));
      if (k === key) delete keyMap[key]; else keyMap[key] = k;
      localStorage.setItem("keyMap", JSON.stringify(keyMap));
      inp.value = k.toUpperCase();
    });
    l.append(span, inp);
    grid2.append(l);
  }
  box.append(grid2);
  const tourBtn = Object.assign(document.createElement("button"), { textContent: tr("Show the tour again") });
  tourBtn.addEventListener("click", () => { $("#options-dialog").classList.add("hidden"); showTour(0); });
  box.append(tourBtn);
  const reset = Object.assign(document.createElement("button"), { textContent: tr("Default keys") });
  reset.addEventListener("click", () => { keyMap = {}; localStorage.removeItem("keyMap"); renderOptions(); });
  box.append(reset);
}
$("#btn-options").addEventListener("click", () => { renderOptions(); $("#options-dialog").classList.remove("hidden"); });
$("#opt-close").addEventListener("click", () => $("#options-dialog").classList.add("hidden"));
$("#opt-reset").addEventListener("click", () => {
  if (!confirm(tr("Reset all options to their defaults?"))) return;
  options = { ...OPTION_DEFAULTS };
  localStorage.setItem("options", JSON.stringify(options));
  applyOptions(); renderOptions();
});
applyOptions();

// ---------- right-click menu on objects (a right click without dragging) ----------
let rightDown = null;
renderer.domElement.addEventListener("pointerdown", (e) => { if (e.button === 2) rightDown = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (!rightDown || Math.hypot(e.clientX - rightDown[0], e.clientY - rightDown[1]) > 4 || tool !== "objects" || !root) return;
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  let hit = null;
  for (const h of raycaster.intersectObject(root, true)) {
    let o = h.object;
    while (o && !o.userData.entity) o = o.parent;
    if (o && o.parent === root && !o.userData.terrain && o.visible) { hit = o; break; }
  }
  if (hit && !selection.includes(hit)) select([hit]);
  const has = selection.length > 0, md = has && comp(primary().userData.entity, "ModelDefinitionComponent");
  const items = [
    [tr("Duplicate"), "Ctrl+D", has, duplicate],
    [tr("Copy"), "Ctrl+C", has, copySelection],
    [tr("Paste here"), "Ctrl+V", !!localStorage.getItem("d2r-clipboard"), paste],
    [tr("Paste at the original places"), "Ctrl+Shift+V", !!localStorage.getItem("d2r-clipboard"), pasteInPlace],
    [tr("Copy the position"), "", has, copyPosition],
    null,
    [tr("Replace with the preview model"), "", has && !!previewPath, replaceWithPreview],
    [tr("Select same model"), "", !!md, selectSameModel],
    [tr("Drop to ground"), "G", has, dropToGround],
    [tr("Random rotation"), "", has, randomRotate],
    [tr("Focus the selection"), "F", has, focusSelection],
    null,
    [tr("Save as group"), "Ctrl+G", has, saveGroup],
    [tr("Save the selection as a kit"), "", has, saveKit],
    [tr("Hide the selection"), "H", has, hideSelection],
    null,
    [tr("Delete"), "Del", has, removeSelected],
  ];
  const menu = $("#ctx-menu");
  menu.textContent = "";
  for (const it of items) {
    if (!it) { menu.append(Object.assign(document.createElement("hr"))); continue; }
    const [label, key, on, fn] = it;
    const b = document.createElement("button");
    b.innerHTML = `<span></span><kbd></kbd>`;
    b.firstChild.textContent = label;
    b.lastChild.textContent = key;
    b.disabled = !on;
    b.addEventListener("click", () => { menu.classList.add("hidden"); fn(); });
    menu.append(b);
  }
  menu.classList.remove("hidden");
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  Object.assign(menu.style, { left: `${Math.min(e.clientX, innerWidth - mw - 4)}px`, top: `${Math.min(e.clientY, innerHeight - mh - 4)}px` });
});
window.addEventListener("pointerdown", (e) => { if (!e.target.closest("#ctx-menu")) $("#ctx-menu").classList.add("hidden"); }, true);

// ---------- thumbnails in the model list (rendered once, kept by the server) ----------
const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
thumbRenderer.setSize(96, 96);
thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
const thumbScene = new THREE.Scene();
thumbScene.add(new THREE.HemisphereLight(0xfff4dd, 0x2a2418, 1.8));
const thumbSun = new THREE.DirectionalLight(0xffffff, 2.2);
thumbSun.position.set(-1, 2, 1.5);
thumbScene.add(thumbSun);
const thumbCam = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
const thumbQueue = [];
let thumbBusy = false;
function queueThumb(img) { thumbQueue.push(img); runThumbs(); }
async function runThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length) {
    const img = thumbQueue.shift();
    if (!img.isConnected) continue;
    const path = img.dataset.model;
    const g = await new Promise((ok) => loader.load(api("model", { v: ASSET_VERSION, lod: 2, path }), (r) => ok(r.scene), undefined, () => ok(null)));
    if (!g) { img.classList.add("none"); continue; }
    g.traverse((o) => { if (o.isMesh && o.material && o.material.map) o.material.map.colorSpace = THREE.SRGBColorSpace; });
    const box = new THREE.Box3().setFromObject(g), size = box.getSize(new THREE.Vector3());
    g.position.sub(box.getCenter(new THREE.Vector3()));
    thumbScene.add(g);
    const r = Math.max(size.x, size.y, size.z) || 1;
    thumbCam.position.set(r * 0.9, r * 0.7, r * 1.3);
    thumbCam.lookAt(0, 0, 0);
    thumbRenderer.render(thumbScene, thumbCam);
    const url = thumbRenderer.domElement.toDataURL("image/webp", 0.8);
    thumbScene.remove(g);
    g.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); }); } });
    img.src = url;
    postJSON("thumb", { path }, { data: url });
  }
  thumbBusy = false;
}
const thumbObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const img = en.target;
    thumbObserver.unobserve(img);
    img.onerror = () => { img.onerror = null; queueThumb(img); };
    img.src = api("thumb", { path: img.dataset.model });
  }
}, { root: $("#model-list"), rootMargin: "200px" });

// ---------- where is a model used? ----------
async function showUsage() {
  if (!previewPath) return setStatus(tr("Choose a model in the list first"));
  const box = $("#usage-box");
  box.classList.remove("hidden");
  for (;;) {
    const r = await (await fetch(api("usage", { model: previewPath }))).json();
    if (r.state !== "ready") {
      box.textContent = tr("Looking through all maps once … {0}/{1}").replace("{0}", r.done).replace("{1}", r.total);
      await new Promise((ok) => setTimeout(ok, 1000));
      continue;
    }
    box.textContent = "";
    const head = document.createElement("div");
    head.className = "hint";
    head.textContent = tr("{0} used in {1} map(s):").replace("{0}", previewPath.split("/").pop()).replace("{1}", r.maps.length);
    box.append(head);
    for (const m of r.maps.slice(0, 200)) {
      const a = document.createElement("div");
      a.className = "usage-item";
      a.textContent = m.replace("data/hd/env/preset/", "");
      a.title = tr("Open this map");
      a.addEventListener("click", () => openPreset(m));
      box.append(a);
    }
    return;
  }
}
$("#usage-btn").addEventListener("click", showUsage);

// ---------- first start: a short tour ----------
const TOUR = [
  ["#pane-presets", "Maps: choose a map here. Recently opened maps come first; the project selector is at the top."],
  ['[data-tab="models"]', "Models: search all HD models, see a preview, place them with a double-click, scatter, recolour or import your own."],
  ["#viewport", "The view: left click selects, drag draws a box, right mouse turns, middle mouse pans, the wheel zooms. Right-click an object for its menu."],
  [".mode.active", "Move, rotate and scale the selection with W, E and R, or with these buttons."],
  ["#right", "Selection: position, rotation, size and many tools for the selected objects; below, game objects and the map."],
  ["#btn-save", "Save the map (Ctrl+S). Unsaved work is also kept as a draft."],
  ["#btn-export", "Export: checks the project and writes everything into the game as a mod (D2RLoader -mod <name>)."],
  ["#btn-options", "Options: camera, grid, autosave, keyboard shortcuts and more. ? shows all keys."],
];
let tourStep = -1;
function showTour(i) {
  tourStep = i;
  const box = $("#tour"), hl = $("#tour-hl");
  if (i < 0 || i >= TOUR.length) { box.classList.add("hidden"); hl.classList.add("hidden"); localStorage.setItem("tourDone", "1"); return; }
  const [sel, text] = TOUR[i];
  const el = document.querySelector(sel);
  const r = el ? el.getBoundingClientRect() : { left: innerWidth / 2 - 100, top: innerHeight / 2 - 50, width: 200, height: 100, right: innerWidth / 2 + 100, bottom: innerHeight / 2 + 50 };
  Object.assign(hl.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
  hl.classList.remove("hidden");
  $("#tour-text").textContent = tr(text);
  $("#tour-count").textContent = `${i + 1}/${TOUR.length}`;
  $("#tour-next").textContent = tr(i === TOUR.length - 1 ? "Done" : "Next");
  box.classList.remove("hidden");
  const bw = box.offsetWidth, bh = box.offsetHeight;
  let x = r.right + 12, y = r.top;
  if (x + bw > innerWidth - 8) x = Math.max(8, r.left - bw - 12);
  if (x < 8 || r.width > innerWidth * 0.5) { x = Math.min(innerWidth - bw - 8, Math.max(8, r.left + r.width / 2 - bw / 2)); y = r.bottom + 12; }
  if (y + bh > innerHeight - 8) y = Math.max(8, r.top + 20);
  Object.assign(box.style, { left: `${x}px`, top: `${y}px` });
}
$("#tour-next").addEventListener("click", () => showTour(tourStep + 1));
$("#tour-skip").addEventListener("click", () => showTour(-1));
if (!localStorage.getItem("tourDone")) setTimeout(() => showTour(0), 1500);

// ---------- tabs of open maps: switch without losing unsaved work (kept as a draft) ----------
let mapTabs = JSON.parse(localStorage.getItem("mapTabs") || "[]");  // [{ path, draft }]
function saveTabs() { localStorage.setItem("mapTabs", JSON.stringify(mapTabs)); }
function renderTabs() {
  const bar = $("#map-tabs");
  bar.textContent = "";
  bar.classList.toggle("hidden", !mapTabs.length);
  for (const t of mapTabs) {
    const b = document.createElement("div");
    b.className = "map-tab" + (t.path === presetPath ? " active" : "");
    b.title = t.path;
    const name = document.createElement("span");
    const unsaved = t.path === presetPath ? dirty : t.draft;
    name.textContent = (unsaved ? "● " : "") + t.path.replace("data/hd/env/preset/", "").replace(/\.json$/, "");
    const x = document.createElement("button");
    x.textContent = "✕";
    x.title = tr("Close the tab (unsaved work stays as a draft)");
    x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.path); });
    b.append(name, x);
    b.addEventListener("click", () => switchTab(t.path));
    b.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.path); } });
    b.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });  // no autoscroll
    bar.append(b);
  }
}
function addTab(path) {
  if (!mapTabs.some((t) => t.path === path)) { mapTabs.push({ path, draft: false }); if (mapTabs.length > 12) mapTabs.shift(); }
  saveTabs(); renderTabs();
}
async function keepAsDraft() {
  if (!dirty || !doc || !presetPath) return;
  await postJSON("draft", { path: presetPath }, doc);
  const t = mapTabs.find((x) => x.path === presetPath);
  if (t) t.draft = true;
  dirty = false;
  saveTabs();
}
async function switchTab(path) {
  if (path === presetPath) return;
  await keepAsDraft();
  openPreset(path, { fromTab: true });
}
async function closeTab(path) {
  if (path === presetPath) await keepAsDraft();
  mapTabs = mapTabs.filter((t) => t.path !== path);
  saveTabs(); renderTabs();
}
renderTabs();

// ---------- combine two exported mods ----------
async function openMods() {
  const mods = await (await fetch(api("mods"))).json();
  for (const id of ["#mm-a", "#mm-b"]) {
    const sel = $(id);
    sel.textContent = "";
    for (const m of mods) sel.append(new Option(m, m));
  }
  if (mods.length > 1) $("#mm-b").selectedIndex = 1;
  $("#mm-result").textContent = "";
  $("#mods-dialog").classList.remove("hidden");
}
$("#mm-check").addEventListener("click", async () => {
  const r = await (await fetch(api("mods/check", { a: $("#mm-a").value, b: $("#mm-b").value }))).json();
  if (r.error) return ($("#mm-result").textContent = r.error);
  const kinds = { table: tr("data table: merged row by row"), strings: tr("texts: merged by key"), file: tr("file: only one can win") };
  $("#mm-result").textContent = r.conflicts.length
    ? tr("{0} file(s) changed by both:").replace("{0}", r.conflicts.length) + "\n" + r.conflicts.map((c) => `  ${c.file}  (${kinds[c.kind]})`).join("\n")
    : tr("No file is changed by both mods: they work side by side when merged.");
  if (!$("#mm-out").value) $("#mm-out").value = `${$("#mm-a").value}_${$("#mm-b").value}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
});
$("#mm-merge").addEventListener("click", async () => {
  const r = await postJSON("mods/merge", { a: $("#mm-a").value, b: $("#mm-b").value, out: $("#mm-out").value, bwins: $("#mm-bwins").checked ? 1 : 0 });
  if (!r.ok) return ($("#mm-result").textContent = r.data.error);
  const d = r.data;
  let msg = d.written ? tr("Merged mod written: {0}").replace("{0}", d.written) : tr("Not merged: these files clash (tick \"second mod wins\" to take the second mod's version):");
  if (d.clashes.length) msg += "\n" + d.clashes.map((c) => "  ✗ " + c).join("\n");
  if (d.merged.length) msg += "\n" + tr("Merged row by row:") + "\n" + d.merged.map((c) => "  ✓ " + c).join("\n");
  if (d.warnings.length) msg += "\n" + tr("Check:") + "\n" + d.warnings.map((c) => "  ! " + c).join("\n");
  $("#mm-result").textContent = msg;
});
$("#ex-mods").addEventListener("click", () => { $("#export-dialog").classList.add("hidden"); openMods(); });
$("#mm-close").addEventListener("click", () => $("#mods-dialog").classList.add("hidden"));

// ---------- new map: a copy of a game map under a new name, optionally empty ----------
async function newMap() {
  const template = presetPath;
  if (!template) return setStatus(tr("Open the map to copy first (its size and ground are used)."));
  const name = prompt("Name of the new map (small letters, digits, _). It is a copy of the open map:", "my_map");
  if (!name) return;
  const empty = confirm(tr("Remove all models and game objects from the copy (keep only the ground)?"));
  const r = await postJSON("newmap", {}, { template, name: name.toLowerCase(), empty });
  if (!r.ok) return setStatus(tr("No new map: {0}").replace("{0}", r.data.error));
  presets = await (await fetch(api("presets"))).json();
  await loadEdited();
  await openPreset(r.data.path);
  setStatus(tr("New map {0} ({1} × {2} tiles). Use it as an area in the act editor or with \"Take over a map\".")
    .replace("{0}", r.data.path.replace("data/hd/env/preset/", "")).replace("{1}", r.data.size[0]).replace("{2}", r.data.size[1]));
}
$("#preset-new").addEventListener("click", newMap);

// act editor: an area with a fixed map (a map of the project or the game, edited in the editor)
async function addMapArea() {
  const path = prompt("Map of the new area (path as in the Maps list, e.g. act1/court/my_map.json). Make one with \"New map\" in the Maps tab first:",
    presetPath ? presetPath.replace("data/hd/env/preset/", "") : "");
  if (!path) return;
  const full = path.startsWith("data/") ? path : "data/hd/env/preset/" + path;
  const info = await (await fetch(api("presetinfo2", { path: full }))).json();
  if (info.error) return setStatus(info.error);
  // the level settings come from a game level that uses a map piece of this folder
  let row = info.rows.find((r) => r.levelId > 0 && r.levelId < 137) || info.rows.find((r) => r.levelId > 0);
  if (!row) {
    const folder = full.split("/").slice(0, -1).join("/");
    for (const sib of presets.filter((p) => p.startsWith(folder + "/") && p !== full).slice(0, 40)) {
      const rs = (await (await fetch(api("presetinfo2", { path: sib }))).json()).rows;
      row = rs.find((r) => r.levelId > 0 && r.levelId < 137) || rs.find((r) => r.levelId > 0);
      if (row) break;
    }
  }
  if (!row) return setStatus(tr("No game level uses maps of this folder; choose a map from another folder"));
  const taken = act.zones.filter((z) => z.offset).map((z) => [z.offset[0], z.offset[1], 220, 220]);
  const free = await (await fetch(api("world/free", { w: info.size[0], h: info.size[1], taken: JSON.stringify(taken) }))).json();
  if (free.error) return setStatus(free.error);
  const name = prompt("Name of the new area:", "New Glade");
  if (!name) return;
  const prefix = act.prefix || "a6";
  const key = prefix.toUpperCase() + name.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  const id = Math.max(...act.zones.map((z) => z.id)) + 1;
  const own = full.split("/").pop().startsWith(prefix + "_");
  act.zones.push({ id, key, name, open: act.quest.length, template_level: row.levelId, lvlprest: row.name, preset: full,
    path: own ? full : full.replace(/[^/]+\.json$/, `${prefix}_${name.toLowerCase().replace(/[^a-z0-9]/g, "")}.json`),
    offset: free.offset, monsters: ["fallen1", "skeleton1"], mlvl: [45, 69, 85],
    design: { keep_map: true, keep_objects: true, objects: [] } });
  renderAct();
  setStatus(tr("Area {0} added at {1}, {2}. After the first build its map is in the project: edit it there, later builds keep it.")
    .replace("{0}", name).replace("{1}", free.offset[0]).replace("{2}", free.offset[1]));
}

// ---------- effects shown as simple particles (fire, smoke and fog, flies, water, magic) ----------
const FX_KINDS = [
  [/fire|torch|flame|ember|brazier|burn|lava|candle/i, { color: 0xff8a2a, count: 26, size: 0.9, rise: 2.4, spread: 0.6, life: 1.1, blend: true }],
  [/smoke|fog|mist|haze|dust|cloud|steam/i, { color: 0x8a857c, count: 10, size: 2.2, rise: 0.2, spread: 4, life: 6, blend: false, opacity: 0.06 }],
  [/fl(y|ies)|insect|bug|moth|bat/i, { color: 0x222018, count: 10, size: 0.35, rise: 0, spread: 2.5, life: 3, blend: false, buzz: true }],
  [/water|drip|splash|rain|fountain|wave/i, { color: 0x6fb7ff, count: 18, size: 0.5, rise: -1.5, spread: 1.5, life: 1.4, blend: true }],
  [/magic|glow|spark|portal|light|aura|rune|holy|soul/i, { color: 0xc77dff, count: 18, size: 0.6, rise: 0.8, spread: 1.2, life: 2, blend: true }],
];
const fxSystems = new Set();
const fxTexture = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.4, "rgba(255,255,255,.6)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
function fxFor(ent) {
  const v = comp(ent, "VfxDefinitionComponent");
  if (!v) return null;
  const name = (v.filename || ent.name || "").split("/").pop();
  const kind = (FX_KINDS.find(([rx]) => rx.test(name)) || [null, { color: 0xc77dff, count: 12, size: 0.5, rise: 0.6, spread: 1, life: 2, blend: true }])[1];
  const n = kind.count;
  const pos = new Float32Array(n * 3), st = [];
  for (let i = 0; i < n; i++) st.push({ age: Math.random() * kind.life, seed: Math.random() * 100 });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: kind.color, size: kind.size, map: fxTexture, transparent: true, depthWrite: false,
    opacity: kind.opacity ?? 0.85, blending: kind.blend ? THREE.AdditiveBlending : THREE.NormalBlending });
  const pts = new THREE.Points(geo, mat);
  pts.userData.fx = { kind, st };
  pts.userData.helperFx = true;
  pts.raycast = () => {};  // effects are picked by their marker, not by the particles
  fxSystems.add(pts);
  return pts;
}
let fxLast = performance.now();
function updateFx() {
  const now = performance.now(), dt = Math.min(0.1, (now - fxLast) / 1000);
  fxLast = now;
  for (const p of fxSystems) {
    let top = p;
    while (top.parent) top = top.parent;
    if (top !== scene) { fxSystems.delete(p); p.geometry.dispose(); p.material.dispose(); continue; }
    p.visible = options.effects && showHelpers;
    if (!p.visible) continue;
    const { kind, st } = p.userData.fx, a = p.geometry.attributes.position.array;
    const s = p.parent.scale, sx = 1 / (s.x || 1), sy = 1 / (s.y || 1), sz = 1 / (s.z || 1);
    st.forEach((q, i) => {
      q.age += dt;
      if (q.age > kind.life) { q.age = 0; q.seed = Math.random() * 100; }
      const t = q.age / kind.life, r = kind.spread * (kind.buzz ? 1 : 0.3 + t);
      const ang = q.seed * 7 + (kind.buzz ? now / 300 * (1 + (q.seed % 1)) : 0);
      a[i * 3] = Math.cos(ang) * r * ((q.seed * 13) % 1) * sx;
      a[i * 3 + 1] = (1 + kind.rise * q.age + (kind.buzz ? Math.sin(now / 200 + q.seed) * 0.5 + 1.5 : 0)) * sy;
      a[i * 3 + 2] = Math.sin(ang) * r * ((q.seed * 17) % 1) * sz;
    });
    p.geometry.attributes.position.needsUpdate = true;
  }
}

// ---------- into the game: start right at the view centre of this map ----------
async function playHere() {
  if (!presetPath) return setStatus(tr("Open a map first."));
  if (dirty) await save();
  const at = orbit.target;
  if (!confirm(tr("Export the mod and start the game at the view centre of this map? (The game must be closed.)"))) return;
  setStatus(tr("Exporting and starting the game …"));
  const r = await postJSON("play", {}, { path: presetPath, x: at.x, z: at.z });
  if (!r.ok) return setStatus(tr("Not started: {0}").replace("{0}", r.data.error));
  setStatus(tr("The game starts with mod {0} and goes to {1}; after that it is yours.").replace("{0}", r.data.mod).replace("{1}", r.data.levelName));
}
$("#btn-play").addEventListener("click", playHere);

async function testAct() {
  if (!confirm(tr("Test the act in the game: export first with \"Build and export\". The game starts on the second monitor, muted, visits every area and closes. Start?"))) return;
  const r = await postJSON("world/test");
  if (!r.ok) return ($("#acts-log").textContent = tr("Test not started: {0}").replace("{0}", r.data.error));
  $("#acts-log").textContent = tr("Act test running: {0} areas …").replace("{0}", r.data.areas);
  const poll = async () => {
    const s = await (await fetch(api("play"))).json();
    if (s.test.running) return setTimeout(poll, 2000);
    $("#acts-log").textContent = s.test.report;
  };
  setTimeout(poll, 3000);
}
$("#acts-test").addEventListener("click", testAct);

// ---------- ground: terrain stamps paint the biome's ground layers through a mask ----------
let biomeLayers = [];          // terrain layers of the open map's biome (name, Albedo)
let stampMasks = null;
const stampTexCache = new Map();
function stampTexture(path) {
  if (!stampTexCache.has(path)) {
    const t = new THREE.TextureLoader().load(api("texture", { path }));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    stampTexCache.set(path, t);
  }
  return stampTexCache.get(path);
}
const blankTex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
blankTex.needsUpdate = true;
function stampMaterial(sc) {
  const alb = (i) => { const l = biomeLayers[i]; return l && l.Albedo ? stampTexture(l.Albedo) : blankTex; };
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    uniforms: { mask: { value: stampTexture(sc.mask) }, aR: { value: alb(sc.layerIndexR) }, aG: { value: alb(sc.layerIndexG) },
      aB: { value: alb(sc.layerIndexB) }, rep: { value: 4.0 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `uniform sampler2D mask, aR, aG, aB; uniform float rep; varying vec2 vUv;
      void main(){ vec4 m = texture2D(mask, vUv); vec2 t = vUv * rep;
        float sum = m.r + m.g + m.b;
        vec3 c = (texture2D(aR, t).rgb * m.r + texture2D(aG, t).rgb * m.g + texture2D(aB, t).rgb * m.b) / max(sum, 0.001);
        float a = clamp(max(m.r, max(m.g, m.b)), 0.0, 1.0);
        gl_FragColor = vec4(c * 0.85, a * 0.9); }`,
  });
}
function stampPlane(ent) {
  const sc = comp(ent, "TerrainStampDefinitionComponent");
  if (!sc || !sc.mask || !options.stamps) return null;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), stampMaterial(sc));
  m.position.y = 0.15;
  m.renderOrder = 2;
  m.userData.stamp = true;
  m.raycast = () => {};
  return m;
}
async function loadStampMasks() {
  if (!stampMasks) stampMasks = await (await fetch(api("stamps"))).json();
  const sel = $("#st-mask");
  sel.textContent = "";
  for (const m of stampMasks) sel.append(new Option(m.split("/").pop().replace(/_STAMP\.texture$/i, "").replace(/\.texture$/, ""), m));
  const layers = biomeLayers.map((l, i) => new Option(`${i}: ${(l.name || "").replace(/.*terrainLayers_/, "layer ")} – ${(l.Albedo || "").split("/").pop().replace(/_ALB\.texture$/i, "")}`, i));
  for (const id of ["#st-r", "#st-g", "#st-b"]) {
    const s = $(id), keep = s.value;
    s.textContent = "";
    layers.forEach((o) => s.append(new Option(o.text, o.value)));
    if (keep !== "") s.value = keep;
  }
}
let stampOn = false, stampStroke = null;
function toggleStampBrush() {
  stampOn = !stampOn;
  $("#st-brush").classList.toggle("active", stampOn);
  setStatus(stampOn ? tr("Ground brush: click or drag to stamp (Esc ends it)") : tr("Ground brush off"));
}
async function placeStamp(at, yaw = null) {
  const size = Math.max(2, +$("#st-size").value || 20), strength = Math.max(0, Math.min(1, +$("#st-strength").value || 0.6));
  const biomeName = (doc.biomeFilename || "").split("/").pop().replace(/\.json$/, "");
  const name = `stamp_${Date.now() % 100000}_${Math.floor(Math.random() * 1000)}`;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw !== null ? yaw : $("#st-rot").checked ? Math.random() * Math.PI * 2 : 0);
  const ent = { type: "Entity", name, id: newId(), components: [
    { type: "TransformDefinitionComponent", name: `${name}_TransformDefinitionComponent`, position: { x: at.x, y: 0, z: at.z },
      orientation: { x: q.x, y: q.y, z: q.z, w: q.w }, scale: { x: size, y: 80, z: size }, inheritOnlyPosition: false },
    { type: "TerrainStampDefinitionComponent", name: `${name}_TerrainStampDefinition`, mask: $("#st-mask").value,
      stomp: strength, stompG: strength, stompB: strength, snapOptions: 7, biomeName,
      layerIndexR: +$("#st-r").value || 0, layerIndexG: +$("#st-g").value || 0, layerIndexB: +$("#st-b").value || 0 },
  ] };
  doc.entities.push(ent);
  return addObjectFor(ent);
}
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (!stampOn || e.button !== 0 || tool !== "objects") return;
  e.stopImmediatePropagation();
  if (!doc || !cursorGround || !$("#st-mask").value) return setStatus(tr("Open a map and choose a mask first"));
  beginEdit();
  stampStroke = { last: null, made: [] };
  orbit.enabled = false;
}, true);
renderer.domElement.addEventListener("pointermove", async () => {
  if (!stampStroke || !cursorGround) return;
  const spacing = Math.max(2, (+$("#st-size").value || 20) * 0.6);
  if (stampStroke.last && stampStroke.last.distanceTo(cursorGround) < spacing) return;
  stampStroke.last = cursorGround.clone();
  stampStroke.made.push(await placeStamp(cursorGround.clone()));
});
renderer.domElement.addEventListener("pointerup", (e) => { if (stampOn) e.stopImmediatePropagation(); }, true);
window.addEventListener("pointerup", async () => {
  if (!stampStroke) return;
  const s = stampStroke;
  stampStroke = null;
  orbit.enabled = true;
  if (!s.last && cursorGround) s.made.push(await placeStamp(cursorGround.clone()));
  if (!s.made.length) { undoStack.pop(); return; }
  markDirty();
  setStatus(tr("{0} ground stamp(s) placed").replace("{0}", s.made.length));
});
$("#st-brush").addEventListener("click", toggleStampBrush);
$("#st-box").addEventListener("toggle", () => { if ($("#st-box").open) loadStampMasks(); });

// ---------- loot: treasure classes (chests, bosses, monsters) ----------
let lootName = null;
async function lootSearch() {
  const list = await (await fetch(api("loot", { q: $("#lt-q").value }))).json();
  const ul = $("#lt-list");
  ul.textContent = "";
  for (const n of list) {
    const li = document.createElement("li");
    li.textContent = n;
    li.classList.toggle("active", n === lootName);
    li.onclick = () => lootOpen(n);
    ul.append(li);
  }
}
async function lootOpen(name) {
  lootName = name;
  const r = await (await fetch(api("loot", { name }))).json();
  if (r.error) return setStatus(r.error);
  document.querySelectorAll("#lt-list li").forEach((li) => li.classList.toggle("active", li.textContent === name));
  const f = r.fields, box = $("#lt-form");
  const num = (k, label, title) => `<label title="${title || ""}">${tr(label)} <input data-tc="${k}" value="${f[k] || ""}"></label>`;
  let html = `<h4><span translate="no">${name}</span>${r.changed ? ` <span class="changed">(${tr("changed")})</span>` : ""}</h4><div class="tc-grid">` +
    num("Picks", "Picks", tr("How many times the list is drawn (negative: every entry its Prob times)")) + num("NoDrop", "Nothing (weight)") +
    num("Unique", "Unique (per mille)") + num("Set", "Set (per mille)") + num("Rare", "Rare (per mille)") + num("Magic", "Magic (per mille)") + "</div>" +
    `<table class="act-table"><tr><th>${tr("Entry (treasure class or item code)")}</th><th>${tr("Weight")}</th></tr>`;
  for (let i = 1; i <= 10; i++) html += `<tr><td><input data-tc="Item${i}" list="tc-names" value="${f["Item" + i] || ""}"></td><td><input data-tc="Prob${i}" value="${f["Prob" + i] || ""}"></td></tr>`;
  box.innerHTML = html + "</table>";
  $("#lt-save").disabled = $("#lt-reset").disabled = false;
}
$("#lt-q").addEventListener("input", () => { clearTimeout(lootSearch.t); lootSearch.t = setTimeout(lootSearch, 250); });
$("#lt-save").addEventListener("click", async () => {
  const fields = Object.fromEntries([...document.querySelectorAll("[data-tc]")].map((i) => [i.dataset.tc, i.value]));
  const r = await postJSON("loot", {}, { name: lootName, fields });
  setStatus(r.ok ? tr("Loot {0} saved; it goes into the mod with the export").replace("{0}", lootName) : tr("Not saved: {0}").replace("{0}", r.data.error));
  if (r.ok) lootOpen(lootName);
});
$("#lt-reset").addEventListener("click", async () => {
  if (!confirm(tr("Put {0} back as in the game?").replace("{0}", lootName))) return;
  await postJSON("loot", {}, { name: lootName, reset: true });
  lootOpen(lootName);
});
$("#btn-loot").addEventListener("click", async () => {
  $("#loot-dialog").classList.remove("hidden");
  if (!$("#tc-names").options.length) {
    const all = await (await fetch(api("loot", { q: "" }))).json();
    $("#tc-names").innerHTML = all.map((n) => `<option value="${n.replace(/"/g, "&quot;")}">`).join("");
  }
  if (!$("#lt-q").value) $("#lt-q").value = "Chest";
  lootSearch();
});
$("#lt-close").addEventListener("click", () => $("#loot-dialog").classList.add("hidden"));

// ---------- panels: drag the left and right panel wider or narrower ----------
const PANEL_DEFAULT = { left: 300, right: 280 };
function setPanelWidth(side, w, keep = true) {
  if (keep) localStorage.setItem("panel-" + side, Math.round(w));  // the wish; small windows only show less
  // the 3D view keeps at least 360 pixels between the panels
  const other = $("#" + (side === "left" ? "right" : "left")).getBoundingClientRect().width || 0;
  const max = Math.max(200, Math.floor(Math.min(innerWidth * 0.45, innerWidth - other - 360 - 14)));
  w = Math.max(200, Math.min(max, Math.round(w)));
  $("#" + side).style.width = w + "px";
  // the model preview grows with the panel
  if (side === "left") document.documentElement.style.setProperty("--thumb", w >= 420 ? "60px" : w >= 340 ? "50px" : "40px");
  if (side === "left") $("#preview").style.height = Math.round(Math.min(480, innerHeight * 0.32, Math.max(180, w * 0.72))) + "px";
  resize();
}
for (const side of ["left", "right"]) {
  const saved = +localStorage.getItem("panel-" + side);
  setPanelWidth(side, saved || PANEL_DEFAULT[side], false);
}
document.querySelectorAll(".splitter").forEach((sp) => {
  const side = sp.dataset.side;
  sp.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { sp.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    sp.classList.add("dragging");
    const startX = e.clientX, startW = $("#" + side).getBoundingClientRect().width;
    const move = (ev) => setPanelWidth(side, side === "left" ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX));
    const up = () => { sp.classList.remove("dragging"); sp.removeEventListener("pointermove", move); sp.removeEventListener("pointerup", up); };
    sp.addEventListener("pointermove", move);
    sp.addEventListener("pointerup", up);
  });
  sp.addEventListener("dblclick", () => setPanelWidth(side, PANEL_DEFAULT[side]));
});
window.addEventListener("resize", () => { for (const side of ["left", "right"]) setPanelWidth(side, +localStorage.getItem("panel-" + side) || PANEL_DEFAULT[side], false); });

// ---------- toolbar: the View menu ----------
$("#btn-view").addEventListener("click", (e) => { e.stopPropagation(); $("#view-pop").classList.toggle("hidden"); });
window.addEventListener("pointerdown", (e) => { if (!e.target.closest(".tb-menu")) $("#view-pop").classList.add("hidden"); }, true);

// ---------- right panel: sections fold away with a click on their heading ----------
(() => {
  const right = $("#right");
  const heads = [...right.querySelectorAll(":scope > h3")];
  for (const h of heads) {
    const sec = document.createElement("section");
    sec.className = "fold";
    h.before(sec);
    const body = document.createElement("div");
    body.className = "fold-body";
    let n = h.nextSibling;
    sec.append(h, body);
    while (n && !(n.nodeType === 1 && n.tagName === "H3")) { const next = n.nextSibling; body.append(n); n = next; }
    const key = "fold-" + (h.textContent || "").trim();
    if (localStorage.getItem(key) === "1") sec.classList.add("closed");
    h.addEventListener("click", () => { sec.classList.toggle("closed"); localStorage.setItem(key, sec.classList.contains("closed") ? "1" : "0"); });
    h.title = "Click: fold away or open";
  }
})();
