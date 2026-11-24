// ---------- own monsters (NPCs tab): look, name, level, life and loot of a game monster ----------
let monData = null, monSel = -1;
async function loadMonsters() {
  monData = await (await fetch(api("monsters"))).json();
  $("#mon-ids").innerHTML = monData.ids.map((m) => `<option value="${m}">`).join("");
  renderMonsters();
}
function renderMonsters() {
  const ul = $("#mon-list");
  ul.textContent = "";
  monData.monsters.forEach((m, i) => {
    if (m.removed) return;
    const li = document.createElement("li");
    li.textContent = `${m.name} · ${m.look}`;
    li.classList.toggle("sel", i === monSel);
    li.addEventListener("click", () => selectMonster(i));
    ul.append(li);
  });
  $("#mon-form").classList.toggle("hidden", monSel < 0);
}
async function previewMonster(look) {
  const g = await loadCharacter(look);
  if (!g) return;
  if (previewObj) previewScene.remove(previewObj);
  previewObj = new THREE.Group();
  const inner = animate(g);
  previewObj.add(inner);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner), size = box.getSize(new THREE.Vector3());
  inner.position.sub(box.getCenter(new THREE.Vector3()));
  previewScene.add(previewObj);
  const r = Math.max(size.x, size.y, size.z) || 1;
  previewCamera.position.set(0, r * 0.4, r * 1.8);
  previewCamera.lookAt(0, 0, 0);
  $("#preview-info").textContent = `${look} · ${tr("animated")}`;
}
function selectMonster(i) {
  monSel = i;
  const m = monData.monsters[i];
  $("#mon-name").value = m.name;
  $("#mon-look").value = m.look;
  $("#mon-tc").value = m.tc || m.look;
  [$("#mon-l1").value, $("#mon-l2").value, $("#mon-l3").value] = m.level || [10, 40, 70];
  $("#mon-hp").value = m.hp || 100;
  renderMonsters();
}
function formToMonster() {
  if (monSel < 0) return;
  const m = monData.monsters[monSel];
  m.name = $("#mon-name").value;
  const before = m.look;
  m.look = $("#mon-look").value.trim();
  if ($("#mon-tc").value.trim() === before) $("#mon-tc").value = m.look;  // loot follows the look until changed
  m.tc = $("#mon-tc").value.trim() || m.look;
  m.level = [+$("#mon-l1").value || 1, +$("#mon-l2").value || 1, +$("#mon-l3").value || 1];
  m.hp = +$("#mon-hp").value || 100;
}
for (const id of ["#mon-name", "#mon-look", "#mon-tc", "#mon-l1", "#mon-l2", "#mon-l3", "#mon-hp"])
  $(id).addEventListener("input", () => { formToMonster(); renderMonsters(); });
$("#mon-look").addEventListener("change", () => previewMonster($("#mon-look").value.trim()));
$("#mon-new").addEventListener("click", () => {
  if (!monData) return;
  monData.monsters.push({ name: tr("New monster"), look: "zombie1", tc: "zombie1", level: [10, 40, 70], hp: 100 });
  selectMonster(monData.monsters.length - 1);
  previewMonster("zombie1");
});
$("#mon-remove").addEventListener("click", () => { if (monSel < 0) return; monData.monsters[monSel].removed = true; monSel = -1; renderMonsters(); });
$("#mon-save").addEventListener("click", async () => {
  formToMonster();
  const r = await postJSON("monsters", {}, { monsters: monData.monsters });
  if (!r.ok) return setStatus(tr("Monsters not saved: {0}").replace("{0}", r.data.error));
  monData.monsters = r.data.monsters;
  renderMonsters();
  setStatus(tr("Monsters saved; place them with Add game object (NPC / monster), then export"));
  if (presetPath) loadGameObjects();  // the add list gets them
});

// ---------- own unique items ----------
let itemData = null, itemSel = -1;
async function openItems() {
  itemData = await (await fetch(api("items"))).json();
  $("#it-bases").innerHTML = itemData.bases.map((b) => `<option value="${b.code}">${b.name.replace(/"/g, "&quot;")}</option>`).join("");
  $("#it-props").innerHTML = itemData.props.map((p) => `<option value="${p}">`).join("");
  itemSel = itemData.items.length ? 0 : -1;
  renderItems();
  $("#items-dialog").classList.remove("hidden");
}
function renderItems() {
  const ul = $("#it-list");
  ul.textContent = "";
  itemData.items.forEach((it, i) => {
    const li = document.createElement("li");
    li.textContent = `${it.name} · ${it.code}`;
    li.classList.toggle("active", i === itemSel);
    li.onclick = () => { formToItem(); itemSel = i; renderItems(); };
    ul.append(li);
  });
  const f = $("#it-form");
  f.classList.toggle("hidden", itemSel < 0);
  if (itemSel < 0) return;
  const it = itemData.items[itemSel];
  $("#it-name").value = it.name; $("#it-code").value = it.code;
  $("#it-lvl").value = it.lvl; $("#it-lvlreq").value = it.lvlreq; $("#it-rarity").value = it.rarity;
  const tb = $("#it-proptable");
  tb.innerHTML = `<tr><th>${tr("Property")}</th><th>${tr("Parameter")}</th><th>${tr("Min")}</th><th>${tr("Max")}</th></tr>`;
  for (let k = 0; k < 12; k++) {
    const p = it.props[k] || {};
    tb.insertAdjacentHTML("beforeend", `<tr><td><input data-p="prop" data-k="${k}" list="it-props" value="${p.prop || ""}"></td>` +
      `<td><input data-p="par" data-k="${k}" value="${p.par || ""}"></td><td><input type="number" data-p="min" data-k="${k}" value="${p.min ?? ""}"></td>` +
      `<td><input type="number" data-p="max" data-k="${k}" value="${p.max ?? ""}"></td></tr>`);
  }
}
function formToItem() {
  if (!itemData || itemSel < 0) return;
  const it = itemData.items[itemSel];
  Object.assign(it, { name: $("#it-name").value, code: $("#it-code").value.trim(), lvl: +$("#it-lvl").value || 1,
    lvlreq: +$("#it-lvlreq").value || 1, rarity: +$("#it-rarity").value || 1 });
  const props = [];
  for (let k = 0; k < 12; k++) {
    const g = (p) => $(`[data-p="${p}"][data-k="${k}"]`)?.value ?? "";
    if (g("prop").trim()) props.push({ prop: g("prop").trim(), par: g("par"), min: g("min"), max: g("max") });
  }
  it.props = props;
}
$("#btn-items").addEventListener("click", openItems);
$("#it-close").addEventListener("click", () => $("#items-dialog").classList.add("hidden"));
$("#it-new").addEventListener("click", () => {
  formToItem();
  itemData.items.push({ name: tr("New item"), code: "wax", lvl: 30, lvlreq: 25, rarity: 1, props: [{ prop: "dmg%", par: "", min: 100, max: 150 }] });
  itemSel = itemData.items.length - 1;
  renderItems();
});
$("#it-del").addEventListener("click", () => {
  if (itemSel < 0 || !confirm(tr("Delete this item?"))) return;
  itemData.items.splice(itemSel, 1);
  itemSel = Math.min(itemSel, itemData.items.length - 1);
  renderItems();
});
$("#it-save").addEventListener("click", async () => {
  formToItem();
  const r = await postJSON("items", {}, { items: itemData.items });
  if (!r.ok) return ($("#it-msg").textContent = tr("Not saved: {0}").replace("{0}", r.data.error));
  itemData.items = r.data.items;
  renderItems();
  $("#it-msg").textContent = tr("Saved: {0} item(s). They drop as unique items of their base item; with the export they go into the mod.").replace("{0}", r.data.items.length);
});

// ---------- copy the selection into the other variants of this map (the game picks one of them) ----------
async function copyToVariants() {
  if (!selection.length || !presetPath) return;
  const variants = await (await fetch(api("variants", { path: presetPath }))).json();
  if (!variants.length) return setStatus(tr("This map has no other variants"));
  const names = variants.map((v) => v.replace("data/hd/env/preset/", "")).join("\n");
  if (!confirm(tr("Copy the {0} selected object(s) at the same places into these maps?\n{1}").replace("{0}", selection.length).replace("{1}", names))) return;
  if (dirty) await save();
  const r = await postJSON("copyto", {}, { targets: variants, entities: selection.map((o) => o.userData.entity) });
  if (!r.ok) return setStatus(r.data.error);
  await loadEdited();
  setStatus(tr("Copied into {0} variant(s): {1}").replace("{0}", r.data.maps.length).replace("{1}", r.data.maps.map((m) => m.split("/").pop()).join(", ")));
}

// ---------- the map's lights light the view (the nearest ones, a few at a time) ----------
const LIGHT_POOL = 12;
const lightPool = [];
for (let i = 0; i < LIGHT_POOL; i++) {
  const l = new THREE.PointLight(0xffffff, 0, 10, 1.6);
  l.visible = false;
  scene.add(l);
  lightPool.push(l);
}
let lightTick = 0;
function updateMapLights() {
  if (performance.now() - lightTick < 400) return;
  lightTick = performance.now();
  const on = $("#show-lights").checked && doc;
  const lights = [];
  if (on) {
    for (const o of entityObjects.values()) {
      if (!o.visible) continue;
      const lc = o.userData.entity.components.find((c) => /LightDefinitionComponent$/.test(c.type));
      if (lc) lights.push([o, lc, o.position.distanceToSquared(orbit.target)]);
    }
    lights.sort((a, b) => a[2] - b[2]);
  }
  lightPool.forEach((l, i) => {
    const it = lights[i];
    l.visible = !!it;
    if (!it) return;
    const [o, lc] = it;
    o.getWorldPosition(l.position);
    l.color.setRGB(lc.color?.x ?? 1, lc.color?.y ?? 1, lc.color?.z ?? 1);
    l.distance = (lc.radius || lc.distance || 15) * 1.4;
    l.intensity = Math.min(60, (lc.power || 1000) / 60);
  });
}
$("#show-lights").addEventListener("change", () => { lightTick = 0; updateMapLights(); });

// ---------- camera flight over the stored views 1-4 ----------
let flight = null;
function startFlight() {
  const views = JSON.parse(localStorage.getItem(viewKey()) || "{}");
  const list = ["1", "2", "3", "4"].map((k) => views[k]).filter(Boolean);
  if (list.length < 2) return setStatus(tr("Store at least two views first (Ctrl+1 ... Ctrl+4)"));
  flight = { list, i: 0, t: 0 };
  $("#view-pop").classList.add("hidden");
  setStatus(tr("Camera flight over {0} views (Esc stops it)").replace("{0}", list.length));
}
function updateFlight(dt) {
  if (!flight) return;
  const { list } = flight;
  flight.t += dt / 3;  // three seconds per stretch
  if (flight.t >= 1) { flight.t = 0; flight.i++; }
  if (flight.i >= list.length - 1) { flight = null; return setStatus(tr("Camera flight done")); }
  const a = list[flight.i], b = list[flight.i + 1], s = flight.t * flight.t * (3 - 2 * flight.t);
  camera.position.fromArray(a.p).lerp(new THREE.Vector3().fromArray(b.p), s);
  orbit.target.fromArray(a.t).lerp(new THREE.Vector3().fromArray(b.t), s);
}
$("#btn-flight").addEventListener("click", startFlight);

// ---------- search everything (Ctrl+K): maps, models, objects of the map, kits, figures, options ----------
async function searchAll(q) {
  const ql = q.toLowerCase(), out = [];
  if (!ql) return out;
  for (const p of presets) if (p.includes(ql)) out.push({ kind: "Map", label: p.replace("data/hd/env/preset/", ""), run: () => openPreset(p) });
  if (doc) for (const e of doc.entities) if (e.name.toLowerCase().includes(ql)) out.push({ kind: "Object", label: e.name, run: () => { const o = entityObjects.get(e.id); if (o) { select([o]); flyTo(o.getWorldPosition(new THREE.Vector3())); } } });
  // game objects of the map: NPCs, monsters, chests, waypoints
  (gameObjects?.objects || []).forEach((ob, i) => {
    if (!(ob.name || "").toLowerCase().includes(ql)) return;
    out.push({ kind: ob.type === 1 ? "NPC" : "Game object", label: `${ob.name} (${ob.x}, ${ob.y})`, run: () => {
      const g = gameRoot?.children[i];
      if (!g) return;
      $("#show-objs").checked = gameRoot.visible = true;
      selectGameObject(g);
      flyTo(g.position);
    } });
  });
  for (const k of await (await fetch(api("kits"))).json()) if (k.name.toLowerCase().includes(ql)) out.push({ kind: "Kit", label: k.name, run: () => placeKit(k.name) });
  for (const [, items] of OPTION_FORM) for (const [key, label] of items) if (tr(label).toLowerCase().includes(ql) || label.toLowerCase().includes(ql)) out.push({ kind: "Option", label: tr(label), run: () => { renderOptions(); $("#options-dialog").classList.remove("hidden"); $(`[data-opt="${key}"]`)?.focus(); } });
  const models = await (await fetch(api("models", { q: ql, limit: 25 }))).json();
  for (const m of models.items) out.push({ kind: "Model", label: m.replace("data/hd/", ""), run: () => { document.querySelector('.tab[data-tab="models"]').click(); previewPath = m; showPreview(m); } });
  return out.slice(0, 60);
}
let paletteToken = 0, paletteItems = [], paletteSel = 0;
function renderPalette() {
  const ul = $("#palette-list");
  ul.textContent = "";
  if (!paletteItems.length && $("#palette-input").value.trim()) {
    const li = document.createElement("li");
    li.className = "palette-empty";
    li.textContent = tr("Nothing found");
    ul.append(li);
  }
  paletteItems.forEach((it, i) => {
    const li = document.createElement("li");
    const kind = document.createElement("span");
    kind.className = "pk";
    kind.textContent = tr(it.kind);
    li.append(kind, marked(it.label, $("#palette-input").value));
    li.classList.toggle("active", i === paletteSel);
    li.addEventListener("click", () => runPalette(i));
    ul.append(li);
  });
}
function runPalette(i) {
  const it = paletteItems[i];
  closePalette();
  if (it) it.run();
}
function openPalette() {
  $("#palette").classList.remove("hidden");
  $("#palette-input").value = "";
  paletteItems = [];
  renderPalette();
  $("#palette-input").focus();
}
function closePalette() { $("#palette").classList.add("hidden"); }
$("#palette-input").addEventListener("input", async () => {
  const token = ++paletteToken;
  const items = await searchAll($("#palette-input").value.trim());
  if (token !== paletteToken) return;
  paletteItems = items; paletteSel = 0;
  renderPalette();
});
$("#palette-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    paletteSel = Math.max(0, Math.min(paletteItems.length - 1, paletteSel + (e.key === "ArrowDown" ? 1 : -1)));
    renderPalette();
    $("#palette-list li.active")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") { e.preventDefault(); runPalette(paletteSel); }
});
$("#palette").addEventListener("click", (e) => { if (e.target.id === "palette") closePalette(); });
$("#btn-search").addEventListener("click", openPalette);

// ---------- changes of this map against the game's original, each one can be undone ----------
async function openChanges() {
  if (!doc || !presetPath) return;
  let orig;
  try { orig = await (await fetch(api("preset", { path: presetPath, original: 1 }))).json(); } catch { orig = null; }
  const box = $("#changes-body");
  box.textContent = "";
  if (!orig || !orig.entities) { box.textContent = tr("This map has no original in the game (a new map)"); $("#changes-dialog").classList.remove("hidden"); return; }
  const before = new Map(orig.entities.map((e) => [e.id, e])), now = new Map(doc.entities.map((e) => [e.id, e]));
  const changes = [];
  for (const e of doc.entities) {
    if (!before.has(e.id)) changes.push(["added", e, null]);
    else if (JSON.stringify(before.get(e.id)) !== JSON.stringify(e)) changes.push(["changed", e, before.get(e.id)]);
  }
  for (const e of orig.entities) if (!now.has(e.id)) changes.push(["removed", null, e]);
  const head = document.createElement("div");
  head.className = "hint";
  head.textContent = tr("{0} change(s) against the game's original. \"Undo\" puts one back (Ctrl+Z works too).").replace("{0}", changes.length);
  box.append(head);
  const label = { added: "added", changed: "changed", removed: "removed" };
  for (const [kind, cur, old] of changes) {
    const row = document.createElement("div");
    row.className = "change-row " + kind;
    const k = document.createElement("span");
    k.textContent = tr(label[kind]);
    const n = document.createElement("span");
    n.className = "cn";
    n.textContent = (cur || old).name;
    n.title = tr("Show it");
    n.addEventListener("click", () => { const o = entityObjects.get((cur || old).id); if (o) { select([o]); orbit.target.copy(o.position); } });
    const b = Object.assign(document.createElement("button"), { textContent: tr("Undo") });
    b.addEventListener("click", async () => {
      beginEdit();
      const id = (cur || old).id;
      const o = entityObjects.get(id);
      if (o) { root.remove(o); entityObjects.delete(id); }
      doc.entities = doc.entities.filter((e) => e.id !== id);
      if (old) {
        const back = JSON.parse(JSON.stringify(old));
        doc.entities.push(back);
        await addObjectFor(back);
      }
      select([]);
      markDirty();
      setStatus(tr("Change undone: {0}").replace("{0}", (cur || old).name));
      row.remove();
    });
    row.append(k, n, b);
    box.append(row);
  }
  $("#changes-dialog").classList.remove("hidden");
}
$("#btn-changes").addEventListener("click", openChanges);
$("#changes-close").addEventListener("click", () => $("#changes-dialog").classList.add("hidden"));
