// State in this part is `var`: earlier parts may call these functions while the page starts.

// ---------- game objects: copy, paste, duplicate, move with the arrow keys ----------
function gameObjectAt(i) { return gameObjects?.objects?.[i]; }
function gameCopy() {
  const ob = gameSel && gameObjectAt(gameSel.userData.gameIndex);
  if (!ob) return;
  localStorage.setItem("d2r-game-clip", JSON.stringify({ type: ob.type, id: ob.id, name: ob.name, act: gameObjects.act }));
  localStorage.setItem("d2r-clip-last", "game");
  setStatus(tr("Game object {0} copied").replace("{0}", ob.name));
}
async function gamePaste() {
  const clip = JSON.parse(localStorage.getItem("d2r-game-clip") || "null");
  if (!clip || !gameObjects?.editable) return false;
  // ids differ between acts: the same name in this act
  const list = clip.type === 1 ? gameObjects.catalog.npc : gameObjects.catalog.obj;
  const hit = clip.act === gameObjects.act ? list.find((e) => e.id === clip.id) : list.find((e) => e.name === clip.name);
  if (!hit) { setStatus(tr("{0} does not exist in this act").replace("{0}", clip.name)); return true; }
  const p = cursorGround || orbit.target;
  const objs = currentObjects();
  objs.push({ type: clip.type, id: hit.id, x: Math.floor(p.x / 2), y: Math.floor(p.z / 2), flags: 0 });
  gameSel = null;
  if (await sendGameObjects(objs, beginEdit())) selectGameObject(gameRoot.children[gameRoot.children.length - 1]);
  return true;
}
async function gameDuplicate() {
  const i = gameSel?.userData.gameIndex;
  const ob = gameObjectAt(i);
  if (!ob || !gameObjects.editable) return;
  const objs = currentObjects();
  objs.push({ ...objs[i], x: ob.x + 2, y: ob.y + 2, from: undefined });
  gameSel = null;
  if (await sendGameObjects(objs, beginEdit())) selectGameObject(gameRoot.children[gameRoot.children.length - 1]);
}
function gameNudge(dx, dy) {
  const i = gameSel?.userData.gameIndex;
  const ob = gameObjectAt(i);
  if (!ob || !gameObjects.editable) return;
  editGameObject(i, { x: ob.x + dx, y: ob.y + dy });
}

// ---------- the game object under the mouse is named in the status bar ----------
var hoverGameGroup = null;
function gameObjectUnderMouse() {
  hoverGameGroup = null;
  if (!gameRoot?.visible || !gameRoot.children.length) return null;
  const h = raycaster.intersectObjects(gameRoot.children.map((g) => g.userData.mesh), false)[0];
  if (h) hoverGameGroup = h.object.parent;
  return h ? gameObjectAt(h.object.parent.userData.gameIndex) : null;
}

// ---------- select everything of the same kind (lights, effects, models ...) ----------
function selectSameKind() {
  const p = primary();
  if (!p) return;
  const kind = kindOf(p.userData.entity)[1];
  const all = [...entityObjects.values()].filter((o) => o.visible && !o.userData.terrain && pickable(o) && kindOf(o.userData.entity)[1] === kind);
  select(all);
  setStatus(tr("{0} object(s) of the kind {1} selected").replace("{0}", all.length).replace("{1}", tr(kind)));
}

// ---------- a click on the cursor coordinates copies them ----------
$("#cursor-pos").title = tr("Click: copy the position");
$("#cursor-pos").addEventListener("click", async () => {
  const text = $("#cursor-pos").textContent.trim();
  if (!text) return;
  try { await navigator.clipboard.writeText(text); setStatus(tr("Copied: {0}").replace("{0}", text)); } catch { setStatus(tr("The clipboard could not be used")); }
});

// ---------- map tabs: drag a tab to another place ----------
var dragTab = null;
function makeTabsDraggable() {
  for (const el of document.querySelectorAll("#map-tabs .map-tab")) {
    el.draggable = true;
    el.ondragstart = (e) => { dragTab = el.title; e.dataTransfer.effectAllowed = "move"; };
    el.ondragover = (e) => { if (dragTab) { e.preventDefault(); el.classList.add("drop"); } };
    el.ondragleave = () => el.classList.remove("drop");
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove("drop");
      const from = mapTabs.findIndex((t) => t.path === dragTab), to = mapTabs.findIndex((t) => t.path === el.title);
      dragTab = null;
      if (from < 0 || to < 0 || from === to) return;
      const [t] = mapTabs.splice(from, 1);
      mapTabs.splice(to, 0, t);
      saveTabs(); renderTabs();
    };
  }
}

// ---------- favourite maps: a star in the maps list keeps them on top ----------
function favMaps() { return JSON.parse(localStorage.getItem("favMaps") || "[]"); }
function toggleFavMap(p) {
  const f = favMaps();
  localStorage.setItem("favMaps", JSON.stringify(f.includes(p) ? f.filter((x) => x !== p) : [...f, p]));
  renderPresets();
}
function starFor(p) {
  const s = document.createElement("span");
  const on = favMaps().includes(p);
  s.className = "map-star" + (on ? " on" : "");
  s.textContent = on ? "★" : "☆";
  s.title = tr(on ? "Remove from the favourites" : "Keep on top as a favourite");
  s.onclick = (e) => { e.stopPropagation(); toggleFavMap(p); };
  return s;
}

// ---------- kits can be renamed ----------
async function renameKit() {
  if (!kitSel) return setStatus(tr("Choose a kit in the list first"));
  const name = prompt(tr("New name of the kit:"), kitSel);
  if (!name || name.trim() === kitSel) return;
  const kits = await (await fetch(api("kits"))).json();
  if (kits.some((k) => k.name.toLowerCase() === name.trim().toLowerCase())) return setStatus(tr("A kit {0} exists already").replace("{0}", name.trim()));
  const kit = await (await fetch(api("kit", { name: kitSel }))).json();
  const r = await postJSON("kit", { name: name.trim() }, kit);
  if (!r.ok) return setStatus(r.data.error);
  await postJSON("kit/delete", { name: kitSel });
  setStatus(tr("Kit {0} renamed to {1}").replace("{0}", kitSel).replace("{1}", name.trim()));
  kitSel = name.trim();
  loadKits();
}

// ---------- Ctrl held while dragging a handle: snapping the other way round ----------
var snapFlipped = false;
function flipSnap(on) {
  if (on === snapFlipped || !gizmo.dragging || gameSel) return;
  snapFlipped = on;
  $("#snap").checked = !$("#snap").checked;
  applySnap();
}
window.addEventListener("keydown", (e) => { if (e.key === "Control") flipSnap(true); });
window.addEventListener("keyup", (e) => { if (e.key === "Control" && snapFlipped) { snapFlipped = false; $("#snap").checked = !$("#snap").checked; applySnap(); } });
gizmo.addEventListener("mouseUp", () => { if (snapFlipped) { snapFlipped = false; $("#snap").checked = !$("#snap").checked; applySnap(); } });

// ---------- the View menu remembers its switches ----------
for (const id of ["show-objs", "show-helpers", "show-coll", "show-lights"]) {
  const el = $("#" + id);
  const v = localStorage.getItem("view:" + id);
  // set before the first map opens: the map code reads the switches when it builds its parts
  if (v !== null) el.checked = v === "1";
  if (id === "show-helpers") showHelpers = el.checked;
  if (id === "show-objs" && gameRoot) gameRoot.visible = el.checked;
  el.addEventListener("change", () => localStorage.setItem("view:" + id, el.checked ? "1" : "0"));
}

// ---------- the help window can be searched ----------
function showHelpSearch() {
  showHelp();
  const body = $("#modal-body");
  const all = body.textContent.split("\n");
  const input = Object.assign(document.createElement("input"), { id: "help-search", placeholder: tr("Search the keys …") });
  input.addEventListener("input", () => {
    const q = input.value;
    body.textContent = q ? all.filter((l) => matches(l, q)).join("\n") || tr("Nothing found") : all.join("\n");
  });
  body.before(input);
  setTimeout(() => input.focus(), 0);
}
$("#modal-close").addEventListener("click", () => $("#help-search")?.remove());
new MutationObserver(() => { if ($("#modal").classList.contains("hidden")) $("#help-search")?.remove(); })
  .observe($("#modal"), { attributes: true, attributeFilter: ["class"] });

// ---------- the Export button tells when and where the last export went ----------
function noteExport(mod) {
  localStorage.setItem("lastExport", JSON.stringify({ mod, at: Date.now() }));
  showLastExport();
}
function showLastExport() {
  const l = JSON.parse(localStorage.getItem("lastExport") || "null");
  $("#btn-export").title = l ? tr("Last export: {0} ({1})").replace("{0}", l.mod).replace("{1}", new Date(l.at).toLocaleString(locale())) : tr("Export the project as a mod");
}
showLastExport();
