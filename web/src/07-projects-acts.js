// ---------- projects: separate sets of maps, NPCs and settings ----------
async function loadProjects() {
  const r = await (await fetch(api("projects"))).json();
  const sel = $("#project-select");
  sel.textContent = "";
  for (const p of r.projects) sel.append(new Option(p, p));
  sel.value = r.current;
  window.projectName = r.current;
  $("#proj-info").textContent = r.current;
  updateTitle();
}
async function switchProject(name) {
  if (dirty && !confirm("Discard unsaved changes?")) { $("#project-select").value = window.projectName; return; }
  const r = await postJSON("project", { name });
  if (!r.ok) { $("#project-select").value = window.projectName; return setStatus(tr("Project not switched: {0}").replace("{0}", r.data.error)); }
  dirty = false;
  location.reload();
}
$("#project-select").addEventListener("change", (e) => switchProject(e.target.value));
$("#project-new").addEventListener("click", () => {
  const name = prompt("Name of the new project (letters, digits, space, _ and -):", "");
  if (name) switchProject(name.trim());
});
loadProjects();

// ---------- compare: the game's original map in place of your version (read-only) ----------
let compareRoot = null;
async function toggleCompare() {
  if (!doc) return;
  if (compareRoot) {
    scene.remove(compareRoot);
    compareRoot = null;
    root.visible = true;
    $("#btn-compare").classList.remove("active");
    $("#banner").classList.add("hidden");
    return setStatus(tr("Your version"));
  }
  let orig;
  try {
    orig = await (await fetch(api("preset", { path: presetPath, original: 1 }))).json();
  } catch { return setStatus(tr("This map has no original in the game (a new map)")); }
  if (!orig || !orig.entities) return setStatus(tr("This map has no original in the game (a new map)"));
  select([]);
  compareRoot = new THREE.Group();
  scene.add(compareRoot);
  for (const ent of orig.entities || []) buildEntity(ent, compareRoot);
  root.visible = false;
  $("#btn-compare").classList.add("active");
  const ours = doc.entities.length, theirs = (orig.entities || []).length;
  const banner = $("#banner");
  banner.textContent = tr("Original of the game (read-only): {0} objects, your version: {1}. Press C or the button again to go back.")
    .replace("{0}", theirs).replace("{1}", ours);
  banner.classList.remove("hidden");
  setStatus(tr("Original of the game"));
}
$("#btn-compare").addEventListener("click", toggleCompare);

// ---------- light: day, dusk, night ----------
const hemi = scene.children.find((o) => o.isHemisphereLight);
const LIGHTS = {
  day: { bg: 0x15130f, hemi: [0xfff4dd, 0x2a2418, 1.6], sun: [0xffffff, 2.2] },
  dusk: { bg: 0x1a1210, hemi: [0xffc9a0, 0x241a14, 1.1], sun: [0xff9a5a, 1.6] },
  night: { bg: 0x07090f, hemi: [0x8090c0, 0x101218, 0.55], sun: [0x9fb4ff, 0.6] },
};
function setLight(name) {
  const l = LIGHTS[name] || LIGHTS.day;
  scene.background.setHex(l.bg);
  hemi.color.setHex(l.hemi[0]); hemi.groundColor.setHex(l.hemi[1]); hemi.intensity = l.hemi[2];
  sun.color.setHex(l.sun[0]); sun.intensity = l.sun[1];
  $("#light-select").value = name;
  localStorage.setItem("light", name);
}
$("#light-select").addEventListener("change", (e) => setLight(e.target.value));
setLight(localStorage.getItem("light") || "day");

// ---------- NPC walking paths: draw them with clicks ----------
let pathDraw = null;  // { index, points: [[x, y], ...], line }
function pathLine(points, ob) {
  const pts = [[ob.x, ob.y], ...points].map(([x, y]) => new THREE.Vector3(x * 2 + 1, groundHeight(x * 2 + 1, y * 2 + 1) + 0.4, y * 2 + 1));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false }));
  line.renderOrder = 22;
  return line;
}
function startPath(i) {
  const ob = gameObjects.objects[i];
  pathDraw = { index: i, points: [], line: null };
  setStatus(tr("Path of {0}: click points on the ground · Backspace: remove the last · Enter: done · Esc: cancel").replace("{0}", ob.name));
}
function redrawPath() {
  if (pathDraw.line) { scene.remove(pathDraw.line); pathDraw.line.geometry.dispose(); }
  pathDraw.line = pathLine(pathDraw.points, gameObjects.objects[pathDraw.index]);
  scene.add(pathDraw.line);
}
function endPath(save) {
  const p = pathDraw;
  pathDraw = null;
  if (p.line) { scene.remove(p.line); p.line.geometry.dispose(); }
  if (!save) return setStatus(tr("Path not changed"));
  const objs = currentObjects();
  objs[p.index].path = p.points;
  sendGameObjects(objs, beginEdit()).then((ok) => ok && setStatus(tr("Path saved: {0} point(s)").replace("{0}", p.points.length)));
}
renderer.domElement.addEventListener("pointerdown", (e) => { if (pathDraw && e.button === 0) e.stopImmediatePropagation(); }, true);
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!pathDraw || e.button !== 0 || !cursorGround) return;
  e.stopImmediatePropagation();
  pathDraw.points.push([Math.floor(cursorGround.x / 2), Math.floor(cursorGround.z / 2)]);
  redrawPath();
}, true);
window.addEventListener("keydown", (e) => {
  if (!pathDraw) return;
  if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); endPath(true); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); endPath(false); }
  else if (e.key === "Backspace") { e.preventDefault(); e.stopImmediatePropagation(); pathDraw.points.pop(); redrawPath(); }
}, true);

// ---------- monster groups: several NPCs/monsters around a point in one step ----------
async function addMonsterGroup() {
  if (!gameObjects || !gameObjects.editable) return setStatus("This map has no editable game objects");
  const answer = prompt("Group of the chosen type: count, radius in subtiles (1 tile = 5 subtiles)", localStorage.getItem("groupArgs") || "5, 6");
  if (!answer) return;
  const [count, radius] = answer.split(/[,; ]+/).map(Number);
  if (!(count >= 1 && count <= 40) || !(radius >= 0 && radius <= 50)) return setStatus(tr("Count 1-40 and a radius 0-50, e.g. 5, 6"));
  localStorage.setItem("groupArgs", answer);
  const p = cursorGround || orbit.target;
  const cx = Math.floor(p.x / 2), cy = Math.floor(p.z / 2);
  const maxX = (coll ? coll.width : 1e4) * 5 - 1, maxY = (coll ? coll.height : 1e4) * 5 - 1;
  const objs = currentObjects();
  const before = objs.length;
  const used = new Set(objs.map((o) => `${o.x},${o.y}`));
  for (let i = 0, tries = 0; i < count && tries < count * 30; tries++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * radius;
    const x = Math.max(0, Math.min(maxX, Math.round(cx + Math.cos(a) * r))), y = Math.max(0, Math.min(maxY, Math.round(cy + Math.sin(a) * r)));
    if (used.has(`${x},${y}`)) continue;
    used.add(`${x},${y}`);
    objs.push({ type: +$("#add-obj-type").value, id: +$("#add-obj-id").value, x, y, flags: 0 });
    i++;
  }
  gameSel = null;
  if (await sendGameObjects(objs, beginEdit())) setStatus(tr("{0} game objects added").replace("{0}", objs.length - before));
}
$("#add-obj-group").addEventListener("click", addMonsterGroup);

// ---------- lights: edit colour, power and reach; add new point lights ----------
const toHex = (c) => "#" + [c.x, c.y, c.z].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
const fromHex = (h) => ({ x: parseInt(h.slice(1, 3), 16) / 255, y: parseInt(h.slice(3, 5), 16) / 255, z: parseInt(h.slice(5, 7), 16) / 255 });
function lightProps(o) {
  const lc = o.userData.entity.components.find((c) => /LightDefinitionComponent$/.test(c.type));
  if (!lc) return "";
  const fields = ["power", "radius", "distance", "angle", "attenuation"].filter((k) => typeof lc[k] === "number");
  return `<div class="light-box"><div class="prop-model">${lc.type.replace("DefinitionComponent", "")}</div>` +
    `<div class="prop-row light-row"><span>${tr("Colour")}</span><input type="color" id="lt-color" value="${toHex(lc.color || { x: 1, y: 1, z: 1 })}"></div>` +
    lightPresetButtons() +
    fields.map((k) => `<div class="prop-row light-row"><span>${tr(k)}</span><input type="number" step="any" data-light="${k}" value="${lc[k]}"></div>`).join("") + "</div>";
}
function wireLightProps(o) {
  const lc = o.userData.entity.components.find((c) => /LightDefinitionComponent$/.test(c.type));
  if (!lc || !$("#lt-color")) return;
  wireLightPresets(lc);
  $("#lt-color").addEventListener("change", (e) => { beginEdit(); lc.color = fromHex(e.target.value); markDirty(); setStatus(tr("Light colour changed")); });
  document.querySelectorAll("[data-light]").forEach((inp) => inp.addEventListener("change", () => {
    const v = parseFloat(inp.value);
    if (!Number.isFinite(v)) return;
    beginEdit();
    lc[inp.dataset.light] = v;
    markDirty();
    setStatus(tr("Light changed"));
  }));
}
async function addLight() {
  if (!doc) return setStatus(tr("Open a map first."));
  beginEdit();
  const p = cursorGround || orbit.target;
  const name = `pointlight_${Date.now() % 100000}`;
  const ent = { type: "Entity", name, id: newId(), components: [
    { type: "TransformDefinitionComponent", name: `${name}_TransformDefinitionComponent`, position: { x: p.x, y: groundHeight(p.x, p.z) + 5, z: p.z },
      orientation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, inheritOnlyPosition: false },
    { type: "PointLightDefinitionComponent", name: `${name}_PointLightDefinition`, color: { x: 1, y: 0.85, z: 0.55 }, power: 3000, radius: 15,
      attenuation: 4, lightMask: 1, isLocalLight: false, diffuseContribution: 1, specularContribution: 1 },
  ] };
  doc.entities.push(ent);
  select([await addObjectFor(ent)]);
  markDirty();
  setStatus(tr("Point light added: change its colour and reach under Selection"));
}
$("#add-light").addEventListener("click", addLight);

// ---------- building kits: saved groups of objects to place in any map ----------
let kitSel = null;
async function loadKits() {
  const kits = await (await fetch(api("kits"))).json();
  const ul = $("#kit-list");
  ul.textContent = "";
  if (!kits.length) {
    const li = document.createElement("li");
    li.className = "list-head"; li.setAttribute("translate", "yes");
    li.textContent = "No kits yet: select objects in a map and save them as a kit.";
    ul.append(li);
  }
  for (const k of kits) {
    const li = document.createElement("li");
    li.textContent = `${k.name} (${k.count})`;
    li.title = k.name;
    li.classList.toggle("active", k.name === kitSel);
    li.onclick = () => { kitSel = k.name; ul.querySelectorAll("li").forEach((x) => x.classList.toggle("active", x === li)); };
    li.ondblclick = () => placeKit(k.name);
    ul.append(li);
  }
}
async function saveKit() {
  if (!selection.length) return setStatus(tr("Select the objects of the kit first"));
  const name = prompt("Name of the kit (e.g. camp with torches):", "");
  if (!name) return;
  const anchor = primary().position;
  const items = selection.map((o) => o.userData.entity);
  // game objects (NPCs, monsters, chests) inside the selected area come along, by name
  const box = new THREE.Box3();
  for (const o of selection) box.expandByPoint(o.position);
  box.expandByScalar(4);
  const gameObjs = (gameObjects?.objects || []).filter((ob) => box.containsPoint(new THREE.Vector3(ob.x * 2 + 1, box.min.y + 0.1, ob.y * 2 + 1)))
    .map((ob) => ({ type: ob.type, name: ob.name, dx: ob.x - Math.floor(anchor.x / 2), dy: ob.y - Math.floor(anchor.z / 2) }));
  const r = await postJSON("kit", { name: name.trim() }, { anchor: [anchor.x, anchor.y, anchor.z], items, gameObjects: gameObjs, from: presetPath });
  if (!r.ok) return setStatus(tr("Kit not saved: {0}").replace("{0}", r.data.error));
  kitSel = name.trim();
  await loadKits();
  setStatus(tr("Kit {0} saved ({1} objects)").replace("{0}", name).replace("{1}", items.length + gameObjs.length));
}
async function placeKit(name) {
  if (!doc) return setStatus(tr("Open a map first."));
  const kit = await (await fetch(api("kit", { name }))).json();
  if (!kit.items) return setStatus(tr("Kit not found"));
  const [dx, dz] = await paste(kit);
  let added = 0, missing = 0;
  if ((kit.gameObjects || []).length && gameObjects?.editable) {
    const cat = gameObjects.catalog, objs = currentObjects();
    const ax = Math.floor((kit.anchor[0] + dx) / 2), ay = Math.floor((kit.anchor[2] + dz) / 2);
    for (const g of kit.gameObjects) {
      const hit = (g.type === 1 ? cat.npc : cat.obj).find((e) => e.name === g.name);  // ids differ per act
      if (!hit) { missing++; continue; }
      objs.push({ type: g.type, id: hit.id, x: ax + g.dx, y: ay + g.dy, flags: 0 });
      added++;
    }
    if (added) await sendGameObjects(objs, undoStack[undoStack.length - 1] || beginEdit());
  }
  setStatus(tr("Kit {0} placed ({1} objects)").replace("{0}", name).replace("{1}", kit.items.length + added) +
    (missing ? " · " + tr("{0} game object(s) do not exist in this act").replace("{0}", missing) : ""));
}
$("#kit-save").addEventListener("click", saveKit);
$("#kit-rename").addEventListener("click", () => renameKit());
$("#kit-place").addEventListener("click", () => kitSel ? placeKit(kitSel) : setStatus(tr("Choose a kit in the list first")));
$("#kit-del").addEventListener("click", async () => {
  if (!kitSel || !confirm(tr("Delete the kit {0}?").replace("{0}", kitSel))) return;
  await postJSON("kit/delete", { name: kitSel });
  kitSel = null;
  loadKits();
});

// ---------- act editor: new areas, bosses with their loot, quest chain (d2r-world-mods) ----------
let act = null, actCat = null;
const esc = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
async function openActs() {
  const r = await (await fetch(api("world"))).json();
  $("#acts-dialog").classList.remove("hidden");
  if (!r.available) {
    $("#acts-body").innerHTML = `<p>${esc(tr("The act editor needs the d2r-world-mods tools (World Waypoints and the quest plugin) next to the editor: {0}").replace("{0}", r.path))}</p>`;
    $("#acts-save").disabled = $("#acts-build").disabled = $("#acts-export").disabled = true;
    return;
  }
  act = r.spec;
  actCat = r.catalog;
  $("#acts-save").disabled = $("#acts-build").disabled = $("#acts-export").disabled = false;
  $("#mon-list").innerHTML = actCat.monsters.map((m) => `<option value="${esc(m)}">`).join("");
  renderAct();
}
function bossNames() { return act.bosses.map((b) => b.name); }
function npcNames() { return act.npcs.map((n) => n.name); }
function renderAct() {
  const zoneRows = act.zones.map((z, i) => `<tr>
    <td>${z.id}</td>
    <td><input data-z="${i}" data-f="name" value="${esc(z.name)}"></td>
    <td>${z.town ? tr("town") : "maze_template" in z ? tr("dungeon") : tr("map")}</td>
    <td>${z.town ? "" : `<input type="number" min="0" data-z="${i}" data-f="open" value="${z.open ?? 0}" title="${esc(tr("Quest stage from which the area is open in World Waypoints"))}">`}</td>
    <td>${z.town ? "" : `<input data-z="${i}" data-f="monsters" list="mon-list" value="${esc((z.monsters || []).join(", "))}" title="${esc(tr("Monster ids, comma-separated"))}">`}</td>
    <td>${z.town ? "" : `<input data-z="${i}" data-f="mlvl" value="${esc((z.mlvl || []).join(", "))}" title="${esc(tr("Monster level: normal, nightmare, hell"))}">`}</td>
    <td>${z.town ? "" : `<select data-z="${i}" data-f="boss"><option value="">-</option>${bossNames().map((b) => `<option${b === z.boss ? " selected" : ""}>${esc(b)}</option>`).join("")}</select>`}</td>
    <td>${z.town ? "" : `<button data-zdel="${i}" title="${esc(tr("Remove the area"))}">✕</button>`}</td></tr>`).join("");
  const bossRows = act.bosses.map((b, i) => `<tr>
    <td><input data-b="${i}" data-f="name" value="${esc(b.name)}"></td>
    <td><input data-b="${i}" data-f="look" list="mon-list" value="${esc(b.look)}" title="${esc(tr("The game monster it looks like"))}"></td>
    <td><input data-b="${i}" data-f="level" value="${esc((b.level || []).join(", "))}"></td>
    <td><input type="number" step="0.5" min="0.5" data-b="${i}" data-f="hp" value="${b.hp ?? 1}" title="${esc(tr("Life, times that of Izual"))}"></td>
    <td><select data-b="${i}" data-f="tc" title="${esc(tr("Loot: the drops of this game monster"))}">${actCat.monsters.filter((m) => m === b.tc || /^(izual|diablo|baal|mephisto|andariel|duriel|radament|bloodraven|griswold|summoner|nihlathakboss|putriddefiler1|smith|council1|hephasto|cowking|uberizual|uberdiablo|uberbaal|ubermephisto|uberandariel|uberduriel)/.test(m)).map((m) => `<option${m === b.tc ? " selected" : ""}>${esc(m)}</option>`).join("")}</select></td>
    <td><button data-bdel="${i}">✕</button></td></tr>`).join("");
  const targets = (st) => {
    if ("enter" in st) return `<select data-s="${st._i}" data-f="enter">${act.zones.map((z) => `<option value="${z.id}"${z.id === st.enter ? " selected" : ""}>${esc(z.name)}</option>`).join("")}</select>`;
    if ("kill" in st) return `<select data-s="${st._i}" data-f="kill">${bossNames().map((b) => `<option${b === st.kill ? " selected" : ""}>${esc(b)}</option>`).join("")}</select>`;
    return `<select data-s="${st._i}" data-f="talk">${npcNames().map((n) => `<option${n === st.talk ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
  };
  const goals = act.questlog.goals || {};
  const stepRows = act.quest.map((st, i) => { st._i = i; const kind = "enter" in st ? "enter" : "kill" in st ? "kill" : "talk"; return `<tr>
    <td>${i}</td>
    <td><select data-s="${i}" data-f="kind">${["enter", "kill", "talk"].map((k) => `<option value="${k}"${k === kind ? " selected" : ""}>${tr({ enter: "enter area", kill: "kill boss", talk: "talk to" }[k])}</option>`).join("")}</select></td>
    <td>${targets(st)}</td>
    <td><input data-s="${i}" data-f="quest" value="${esc(st.quest || "")}" placeholder="${esc(tr("(same quest)"))}" title="${esc(tr("A name here starts a new quest in the Quest Log"))}"></td>
    <td><input data-s="${i}" data-f="goal" value="${esc(goals[i] || "")}" title="${esc(tr("Text in the Quest Log while this step is open; | starts a new line"))}"></td>
    <td><button data-sdel="${i}">✕</button></td></tr>`; }).join("");
  const quests = act.questlog.quests.map((q, i) => `<tr><td>${esc(q.name)}</td><td><input data-q="${i}" data-f="done" value="${esc(q.done || "")}"></td></tr>`).join("");
  $("#acts-body").innerHTML = `
    <div class="ex-grid"><label>${tr("Act tab")} <input id="act-tab" value="${esc(act.questlog.tab)}" maxlength="6"></label><label>${tr("Act title")} <input id="act-title" value="${esc(act.questlog.title)}"></label></div>
    <h4>${tr("Areas")}</h4><table class="act-table"><tr><th>ID</th><th>${tr("Name")}</th><th>${tr("Kind")}</th><th>${tr("Open from stage")}</th><th>${tr("Monsters")}</th><th>${tr("Monster level")}</th><th>${tr("Boss")}</th><th></th></tr>${zoneRows}</table>
    <div class="prop-buttons"><button id="act-map-add" title="${esc(tr("An area with a fixed map that you design in the editor"))}">${tr("Add a map area")}</button></div>
    <div class="prop-buttons"><select id="act-maze">${actCat.mazes.map((m) => `<option value="${m.id}">${esc(m.name)} (${m.id})</option>`).join("")}</select><button id="act-zone-add">${tr("Add a dungeon area")}</button></div>
    <h4>${tr("Bosses and their loot")}</h4><table class="act-table"><tr><th>${tr("Name")}</th><th>${tr("Look")}</th><th>${tr("Level")}</th><th>${tr("Life")}</th><th>${tr("Loot like")}</th><th></th></tr>${bossRows}</table>
    <div class="prop-buttons"><button id="act-boss-add">${tr("Add a boss")}</button></div>
    <h4>${tr("Quest chain")}</h4><table class="act-table"><tr><th>${tr("Stage")}</th><th>${tr("Step")}</th><th>${tr("Target")}</th><th>${tr("New quest")}</th><th>${tr("Quest Log text")}</th><th></th></tr>${stepRows}</table>
    <div class="prop-buttons"><button id="act-step-add">${tr("Add a step")}</button></div>
    <h4>${tr("Quest Log: text when a quest is done")}</h4><table class="act-table">${quests}</table>
    <p class="hint">${tr("NPC texts by quest stage are set in the NPCs tab; maps of the areas in the act file ({0}).").replace("{0}", "act6/act6.json")}</p>`;
  wireAct();
}
function questlogFromSteps() {
  // quests start at steps with a name and run until the next one; done texts and icons stay by name
  const old = new Map(act.questlog.quests.map((q) => [q.name, q]));
  const icons = ["a1q1", "a1q6", "a1q2", "a2q1", "a4q1", "a4q2", "a1q3", "a1q4", "a1q5", "a2q2", "a2q3", "a3q1"];
  const qs = [];
  act.quest.forEach((st, i) => { if (st.quest) qs.push({ name: st.quest, first: i }); });
  act.questlog.quests = qs.map((q, k) => ({ first: q.first, last: (qs[k + 1] ? qs[k + 1].first : act.quest.length) - 1,
    icon: old.get(q.name)?.icon || icons[k % icons.length], name: q.name, done: old.get(q.name)?.done || "" }));
}
function wireAct() {
  const body = $("#acts-body");
  const num = (v) => v.split(/[,; ]+/).filter(Boolean).map(Number);
  body.querySelectorAll("[data-z]").forEach((el) => el.addEventListener("change", () => {
    const z = act.zones[+el.dataset.z], f = el.dataset.f;
    if (f === "monsters") z.monsters = el.value.split(/[,; ]+/).filter(Boolean);
    else if (f === "mlvl") z.mlvl = num(el.value);
    else if (f === "open") z.open = +el.value;
    else if (f === "boss") { if (el.value) z.boss = el.value; else delete z.boss; }
    else z[f] = el.value;
  }));
  body.querySelectorAll("[data-b]").forEach((el) => el.addEventListener("change", () => {
    const b = act.bosses[+el.dataset.b], f = el.dataset.f, oldName = b.name;
    if (f === "level") b.level = num(el.value);
    else if (f === "hp") b.hp = +el.value;
    else b[f] = el.value;
    if (f === "name") {  // keep the references
      for (const z of act.zones) if (z.boss === oldName) z.boss = b.name;
      for (const st of act.quest) if (st.kill === oldName) st.kill = b.name;
      renderAct();
    }
  }));
  body.querySelectorAll("[data-s]").forEach((el) => el.addEventListener("change", () => {
    const i = +el.dataset.s, st = act.quest[i], f = el.dataset.f;
    if (f === "kind") {
      for (const k of ["enter", "kill", "talk"]) delete st[k];
      if (el.value === "enter") st.enter = act.zones[0].id;
      else if (el.value === "kill") st.kill = bossNames()[0];
      else st.talk = npcNames()[0];
      return renderAct();
    }
    if (f === "enter") st.enter = +el.value;
    else if (f === "goal") { act.questlog.goals = act.questlog.goals || {}; if (el.value) act.questlog.goals[i] = el.value; else delete act.questlog.goals[i]; }
    else if (f === "quest") { if (el.value) st.quest = el.value; else delete st.quest; questlogFromSteps(); renderAct(); }
    else st[f] = el.value;
  }));
  body.querySelectorAll("[data-q]").forEach((el) => el.addEventListener("change", () => { act.questlog.quests[+el.dataset.q].done = el.value; }));
  body.querySelectorAll("[data-zdel]").forEach((el) => el.addEventListener("click", () => {
    const z = act.zones[+el.dataset.zdel];
    if (act.quest.some((st) => st.enter === z.id)) return setStatus(tr("A quest step still uses this area"));
    act.zones.splice(+el.dataset.zdel, 1); renderAct();
  }));
  body.querySelectorAll("[data-bdel]").forEach((el) => el.addEventListener("click", () => {
    const b = act.bosses[+el.dataset.bdel];
    if (act.quest.some((st) => st.kill === b.name) || act.zones.some((z) => z.boss === b.name)) return setStatus(tr("An area or quest step still uses this boss"));
    act.bosses.splice(+el.dataset.bdel, 1); renderAct();
  }));
  body.querySelectorAll("[data-sdel]").forEach((el) => el.addEventListener("click", () => {
    const i = +el.dataset.sdel;
    act.quest.splice(i, 1);
    const g = {};
    for (const [k, v] of Object.entries(act.questlog.goals || {})) { const n = +k; if (n < i) g[n] = v; else if (n > i) g[n - 1] = v; }
    act.questlog.goals = g;
    act.quest.forEach((st, k) => { st.stage = k; });
    questlogFromSteps(); renderAct();
  }));
  $("#act-tab").addEventListener("change", (e) => { act.questlog.tab = e.target.value; });
  $("#act-title").addEventListener("change", (e) => { act.questlog.title = e.target.value; });
  $("#act-zone-add").addEventListener("click", () => {
    const id = Math.max(...act.zones.map((z) => z.id)) + 1;
    // generated levels sit side by side in a free part of the world (see levels.comment in the act file)
    const used = new Set(act.zones.filter((z) => z.offset).map((z) => z.offset.join(",")));
    let offset = null;
    for (let k = 0; k < 10 && !offset; k++) for (const y of [3300, 3550]) if (!used.has(`${4400 + 250 * k},${y}`)) { offset = [4400 + 250 * k, y]; break; }
    if (!offset) return setStatus(tr("No free place for another generated area"));
    const name = prompt("Name of the new area:", "New Depths");
    if (!name) return;
    const key = (act.prefix || "a6").toUpperCase().replace(/^A/, "A") + name.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
    act.zones.push({ id, key, name, open: act.quest.length, maze_template: +$("#act-maze").value, offset,
      monsters: ["fallen1", "skeleton1"], mlvl: [45, 69, 85], maze: { "Rooms": 12, "Rooms(N)": 12, "Rooms(H)": 12 } });
    renderAct();
  });
  $("#act-map-add").addEventListener("click", addMapArea);
  $("#act-boss-add").addEventListener("click", () => {
    const name = prompt("Name of the new boss:", "");
    if (!name) return;
    act.bosses.push({ name, id: `${act.prefix || "a6"}${name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10)}`, look: "griswold", level: [46, 70, 87], hp: 3, tc: "izual" });
    renderAct();
  });
  $("#act-step-add").addEventListener("click", () => {
    act.quest.push({ stage: act.quest.length, talk: npcNames()[0] });
    questlogFromSteps(); renderAct();
  });
}
function cleanAct() {
  const a = JSON.parse(JSON.stringify(act));
  a.quest.forEach((st, i) => { delete st._i; st.stage = i; });
  return a;
}
async function saveAct() {
  questlogFromSteps();
  const r = await postJSON("world/spec", {}, cleanAct());
  $("#acts-log").textContent = r.ok ? tr("Saved: {0}").replace("{0}", r.data.saved) : tr("Not saved: {0}").replace("{0}", r.data.error);
  return r.ok;
}
async function buildAct(exportToo) {
  if (!(await saveAct())) return;
  const name = exportToo ? (await (await fetch(api("modinfo"))).json()).name : null;
  if (exportToo && !confirm(tr("Build the act, export the mod {0} and install World Waypoints and the quests into it?").replace("{0}", name))) return;
  $("#acts-log").textContent = tr("Building the act … (about a minute)");
  for (const b of ["#acts-build", "#acts-export"]) $(b).disabled = true;
  try {
    const r = await postJSON("world/build", {}, { export: name });
    $("#acts-log").textContent = r.ok ? (r.data.export ? tr("Exported: {0} file(s) to {1}").replace("{0}", r.data.export.files).replace("{1}", r.data.export.mod) + "\n" : "") + r.data.log
      : tr("Build failed: {0}").replace("{0}", r.data.error);
    if (r.ok) { presets = await (await fetch(api("presets"))).json(); loadEdited(); }
  } finally { for (const b of ["#acts-build", "#acts-export"]) $(b).disabled = false; }
}
$("#btn-acts").addEventListener("click", openActs);
$("#acts-close").addEventListener("click", () => $("#acts-dialog").classList.add("hidden"));
$("#acts-save").addEventListener("click", saveAct);
$("#acts-build").addEventListener("click", () => buildAct(false));
$("#acts-export").addEventListener("click", () => buildAct(true));
