// ---------- UI wiring ----------
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
  for (const t of ["presets", "models", "objects", "npcs", "kits"]) $("#pane-" + t).classList.toggle("hidden", b.dataset.tab !== t);
  if (b.dataset.tab === "kits") loadKits();
  if (b.dataset.tab === "npcs") { loadNpcs(); loadMonsters(); }
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
  localStorage.setItem("snapOn", on ? "1" : "0");
}
if (localStorage.getItem("snapOn")) $("#snap").checked = localStorage.getItem("snapOn") === "1";
if (localStorage.getItem("followGround")) $("#follow-ground").checked = localStorage.getItem("followGround") === "1";
$("#follow-ground").addEventListener("change", () => localStorage.setItem("followGround", $("#follow-ground").checked ? "1" : "0"));
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
// ---------- export dialog: mod info, check, optional upload zip ----------
const EXPORT_FIELDS = ["name", "title", "version", "author", "description", "website"];
async function runCheck() {
  const box = $("#ex-check");
  box.textContent = tr("Checking …");
  const r = await (await fetch(api("check"))).json();
  const probs = [...r.problems];
  if (dirty) probs.unshift({ level: "warn", text: tr("The open map has unsaved changes (only saved work is exported)") });
  box.textContent = "";
  if (!probs.length) {
    box.innerHTML = `<div class="ok">✓ ${tr("No problems found")} (${tr("{0} edited map(s)").replace("{0}", r.maps)})</div>`;
  }
  for (const p of probs) {
    const d = document.createElement("div");
    d.className = p.level;
    const icon = document.createElement("span");
    icon.textContent = p.level === "error" ? "✗ " : "! ";
    const text = document.createElement("span");
    text.textContent = p.text;  // own node, so the language module can translate it
    d.append(icon, text);
    const m = /^([\w./-]+\.json):/.exec(p.text);
    if (m && presets.includes("data/hd/env/preset/" + m[1])) {
      d.classList.add("link");
      d.title = tr("Click: open this map");
      d.onclick = () => { $("#export-dialog").classList.add("hidden"); openPreset("data/hd/env/preset/" + m[1]); };
    }
    box.append(d);
  }
  return probs;
}
async function openExport() {
  const info = await (await fetch(api("modinfo"))).json();
  for (const k of EXPORT_FIELDS) $("#ex-" + k).value = info[k] || "";
  if (!info.name || info.name === "D2REditor") $("#ex-name").value = localStorage.getItem("modName") || info.name || "D2REditor";
  $("#ex-result").textContent = "";
  $("#export-dialog").classList.remove("hidden");
  runCheck();
}
$("#btn-export").addEventListener("click", openExport);
$("#ex-cancel").addEventListener("click", () => $("#export-dialog").classList.add("hidden"));
$("#ex-recheck").addEventListener("click", runCheck);
$("#ex-open").addEventListener("click", () => postJSON("reveal"));
$("#ex-go").addEventListener("click", async () => {
  const errors = [...document.querySelectorAll("#ex-check .error")].length;
  if (errors && !confirm(tr("The check found {0} error(s). Export anyway?").replace("{0}", errors))) return;
  const infoBody = Object.fromEntries(EXPORT_FIELDS.map((k) => [k, $("#ex-" + k).value]));
  localStorage.setItem("modName", infoBody.name);
  $("#ex-go").disabled = true;
  $("#ex-result").textContent = tr("Exporting …");
  try {
    const r = await postJSON("export", {}, { info: infoBody, zip: $("#ex-zip").checked });
    if (!r.ok) { $("#ex-result").textContent = tr("Export failed: {0}").replace("{0}", r.data.error); return; }
    let msg = tr("Exported: {0} file(s) to {1}").replace("{0}", r.data.files).replace("{1}", r.data.mod);
    if (r.data.zip) msg += "\n" + tr("Zip for uploading: {0}").replace("{0}", r.data.zip);
    $("#ex-result").textContent = msg;
    $("#ex-open").classList.toggle("hidden", !r.data.zip);
    setStatus(tr("Exported: {0} file(s) to {1}").replace("{0}", r.data.files).replace("{1}", r.data.mod));
  } finally { $("#ex-go").disabled = false; }
});

window.addEventListener("keydown", (e) => {
  const t = e.target;
  // Esc in a field of a dialog closes the dialog
  if (e.key === "Escape" && t?.closest?.(".dialog:not(.hidden)")) { t.closest(".dialog").classList.add("hidden"); return; }
  if (t && (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(t.tagName) || t.isContentEditable)) return;
  if (e.altKey || e.metaKey) return;
  if (document.querySelector(".dialog:not(.hidden), #modal:not(.hidden)") && e.key !== "Escape") return;  // a dialog is open
  const ev = e;
  // , and . by their place on the keyboard (Shift gives other characters on some layouts)
  if (!ev.ctrlKey && (ev.code === "Comma" || ev.code === "Period")) { (ev.shiftKey ? turnGroup : turnSelection)(ev.code === "Comma" ? -1 : 1); return; }
  if (!ev.ctrlKey && (ev.key === "+" || ev.key === "-")) {
    options.gizmoSize = Math.max(0.3, Math.min(3, +(options.gizmoSize + (ev.key === "+" ? 0.1 : -0.1)).toFixed(1)));
    gizmo.size = options.gizmoSize;
    localStorage.setItem("options", JSON.stringify(options));
    return setStatus(tr("Handle size {0}").replace("{0}", options.gizmoSize));
  }
  if (ev.key.length === 1) {
    let key = ev.key.toLowerCase();
    if (!ev.ctrlKey && /^[a-z0-9]$/.test(key)) { key = translateKey(key); if (key === null) return; }  // own shortcuts
    e = { key, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, preventDefault: () => ev.preventDefault() };
  }
  if (e.ctrlKey && e.key === "s") { e.preventDefault(); save(); }
  else if (e.ctrlKey && e.key === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (e.ctrlKey && e.key === "y") { e.preventDefault(); redo(); }
  else if (e.key === "p" && e.shiftKey && previewPath) scatter(cursorGround ? cursorGround.clone() : null);
  else if (e.key === "p" && previewPath && cursorGround) placeModel(previewPath, cursorGround.clone());
  else if (["1", "2", "3", "4"].includes(e.key)) { if (e.ctrlKey) { e.preventDefault(); storeView(e.key); } else recallView(e.key); }
  else if (e.key === "l" && !e.ctrlKey) { setSpace(gizmo.space !== "local"); setStatus(tr(gizmo.space === "local" ? "Gizmo: object axes" : "Gizmo: world axes")); }
  else if (e.key === "m") toggleRuler();
  else if (e.key === "n") toggleMinimap();
  else if (e.key === "c" && !e.ctrlKey) toggleCompare();
  else if (e.key === "g" && e.ctrlKey) { e.preventDefault(); saveGroup(); }
  else if (e.key === "q") setTool("objects");
  else if (e.key === "b") setTool(e.shiftKey ? "blockall" : "block");
  else if (e.key === "x") setTool("clear");
  else if (e.key === "[" || e.key === "]") setBrush(e.key === "]" ? 1 : -1);
  else if (e.key === "h" && e.shiftKey) showHidden();
  else if (e.key === "h") hideSelection();
  else if (e.key === "?" || e.key === "F1") { ev.preventDefault(); showHelp(); }
  else if (e.ctrlKey && e.shiftKey && e.key === "d") { e.preventDefault(); duplicateAtCursor(); }
  else if (e.ctrlKey && e.shiftKey && e.key === "v") { e.preventDefault(); pasteInPlace(); }
  else if (e.ctrlKey && e.key === "i") { e.preventDefault(); invertSelection(); }
  else if (e.ctrlKey && e.shiftKey && e.key === "l") { e.preventDefault(); unlockAll(); }
  else if (e.ctrlKey && e.key === "l") { e.preventDefault(); lockSelection(); }
  else if (e.key === "Home") { e.preventDefault(); viewWholeMap(); }
  else if (e.ctrlKey && e.key === "d") { e.preventDefault(); duplicate(); }
  else if (e.ctrlKey && e.key === "a") { e.preventDefault(); selectAll(); }
  else if (e.key === "w") setMode("translate");
  else if (e.key === "e") setMode("rotate");
  else if (e.key === "r") setMode("scale");
  else if (e.key === "Delete") { if (gameSel) deleteGameObject(gameSel.userData.gameIndex); else removeSelected(); }
  else if (e.key === "o") addGameObject(cursorGround ? cursorGround.clone() : null);
  else if (e.ctrlKey && e.key === "k") { e.preventDefault(); openPalette(); }
  else if (e.key === "Escape" && flight) { flight = null; setStatus(tr("Camera flight stopped")); }
  else if (e.key === "Escape" && measuring) toggleRuler();
  else if (e.key === "Escape" && brushOn) toggleScatterBrush();
  else if (e.key === "Escape" && stampOn) toggleStampBrush();
  else if (e.key === "Escape" && !$("#modal").classList.contains("hidden")) $("#modal").classList.add("hidden");
  else if (e.key === "Escape" && document.querySelector(".dialog:not(.hidden)")) [...document.querySelectorAll(".dialog:not(.hidden)")].pop().classList.add("hidden");
  else if (e.key === "Escape" && !$("#ctx-menu").classList.contains("hidden")) $("#ctx-menu").classList.add("hidden");
  else if (e.key === "Escape" && !$("#view-pop").classList.contains("hidden")) $("#view-pop").classList.add("hidden");
  else if (e.key === "Escape") { selectGameObject(null); select([]); }
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
  else if (e.key === "f") focusSelection();
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
    head.className = "list-head"; head.setAttribute("translate", "yes");
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
    all.className = "list-head"; all.setAttribute("translate", "yes");
    all.textContent = "All maps";
    ul.appendChild(all);
  }
  const onlyEdited = $("#preset-edited").checked;
  for (const p of presets) {
    const short = p.replace("data/hd/env/preset/", "");
    if (f && !matches(short, f)) continue;
    if (onlyEdited && !editedMaps.has(p)) continue;
    const li = document.createElement("li");
    li.append(marked(short, f));
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
    const items = recentModels().filter((m) => matches(m, q));
    r = { items, total: items.length };
  } else if (cat === "__fav") {
    const items = favModels().filter((m) => matches(m, q));
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
    li.title = m;
    if (options.thumbs) {
      li.classList.add("with-thumb");
      const img = document.createElement("img");
      img.className = "thumb";
      img.dataset.model = m;
      img.alt = "";
      li.append(img);
      thumbObserver.observe(img);
    }
    li.append(marked(m.replace("data/hd/", ""), q));
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
setTimeout(() => { if (options.checkUpdates) checkForUpdate(); }, 3000);

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
