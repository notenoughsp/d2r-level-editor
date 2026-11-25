// ---------- selection helpers: invert, turn in steps, paste in place, duplicate at the cursor ----------
function invertSelection() {
  if (!doc) return;
  const now = new Set(selection);
  const all = [...entityObjects.values()].filter((o) => o.visible && !o.userData.terrain && !now.has(o) &&
    (showHelpers || !(o.children[0] && o.children[0].userData.helper)));
  select(all);
  setStatus(tr("{0} object(s) selected").replace("{0}", all.length));
}
// , and . turn the selection around the vertical axis by the rotation snap (each object around itself)
function turnSelection(sign) {
  const deg = (+$("#snap-r").value || 15) * sign;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
  return transformSelection((o) => o.quaternion.premultiply(q), tr("Turned by {0}°").replace("{0}", deg));
}
async function duplicateAtCursor() {
  if (!selection.length || !cursorGround) return;
  copySelectionTo("d2r-dup-clip");
  await paste(JSON.parse(localStorage.getItem("d2r-dup-clip")));
  localStorage.removeItem("d2r-dup-clip");
}
function copySelectionTo(key) {
  const anchor = primary().position;
  localStorage.setItem(key, JSON.stringify({ anchor: [anchor.x, anchor.y, anchor.z], items: selection.map((o) => o.userData.entity) }));
}
async function pasteInPlace() {
  const clip = JSON.parse(localStorage.getItem("d2r-clipboard") || "null");
  if (!clip || !doc) return setStatus(tr("The clipboard is empty"));
  await paste(clip, true);
}
async function copyPosition() {
  const p = primary()?.position || (gameSel && gameSel.position);
  if (!p) return;
  const text = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
  try { await navigator.clipboard.writeText(text); setStatus(tr("Position copied: {0}").replace("{0}", text)); }
  catch { setStatus(text); }
}

// ---------- Home: the whole map in view ----------
function viewWholeMap() {
  if (!root) return;
  const box = new THREE.Box3();
  for (const o of entityObjects.values()) if (o.visible && !o.userData.terrain) box.expandByPoint(o.getWorldPosition(new THREE.Vector3()));
  if (box.isEmpty()) box.setFromObject(root);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const fit = Math.max(size.x, size.z) / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  flyTo(box.getCenter(new THREE.Vector3()), Math.max(20, Math.min(fit * 1.3, 2500)));
}

// ---------- the reach of selected lights, as a ring on the ground and a faint sphere ----------
// (radiusGroup and its materials are set up in 00-core.js: the render loop uses them from the start)
function updateLightRadius() {
  if (radiusFor === selection && radiusGroup.children.length === radiusGroup.userData.n) {
    radiusGroup.children.forEach((m) => m.userData.src.getWorldPosition(m.position));
    return;
  }
  radiusFor = selection;
  for (const m of radiusGroup.children.splice(0)) m.geometry.dispose();
  for (const o of selection) {
    const lc = (o.userData.entity?.components || []).find((c) => /LightDefinitionComponent$/.test(c.type));
    if (!lc) continue;
    const r = lc.radius || lc.distance || 15;
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12), radiusMat);
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos(i / 64 * Math.PI * 2) * r, 0, Math.sin(i / 64 * Math.PI * 2) * r))), ringMat);
    s.add(ring);
    s.userData.src = o;
    o.getWorldPosition(s.position);
    radiusGroup.add(s);
  }
  radiusGroup.userData.n = radiusGroup.children.length;
}

// ---------- the grid marks every tile (10 units) more clearly ----------
function updateTileGrid() {
  tileGrid.visible = options.showGrid && options.gridStep < 10;
}
// the fine grid is moved to the map; the tile lines stay on whole tiles
function syncTileGrid() {
  tileGrid.position.x = Math.round(grid.position.x / 10) * 10;
  tileGrid.position.z = Math.round(grid.position.z / 10) * 10;
}

// ---------- the status line remembers: a click shows the last messages ----------
$("#status").title = tr("Click: earlier messages");
$("#status").addEventListener("click", () => {
  const lines = statusLog.slice().reverse().map(([time, text]) => `${time}  ${tr(text)}`);
  modalShow(tr("Earlier messages"), lines.join("\n") || tr("No messages yet"));
});

// ---------- map tabs: right click closes the other tabs ----------
$("#map-tabs").addEventListener("contextmenu", async (e) => {
  const tab = e.target.closest(".map-tab");
  if (!tab) return;
  e.preventDefault();
  if (mapTabs.length < 2 || !confirm(tr("Close the other tabs? (unsaved work stays as a draft)"))) return;
  const keep = tab.title;
  if (keep !== presetPath) await switchTab(keep);  // the map that was open is kept as a draft
  for (const t of [...mapTabs]) if (t.path !== keep) await closeTab(t.path);
});

// ---------- Ctrl+K also runs commands and goes to coordinates ----------
const PALETTE_BUTTONS = [
  ["btn-save", "Save"], ["btn-undo", "Undo"], ["btn-redo", "Redo"], ["btn-export", "Export"], ["btn-options", "Options"],
  ["btn-help", "Keyboard and mouse"], ["btn-loot", "Loot"], ["btn-items", "Items"], ["btn-acts", "Acts"], ["btn-changes", "Changes against the original"],
  ["btn-flight", "Camera flight"], ["btn-shot", "Screenshot"], ["btn-sd", "Legacy graphics"],
];
const PALETTE_KEYS = [["Home", "The whole map"], ["Invert", "Invert the selection"], ["PasteInPlace", "Paste at the original places"]];
function paletteCommands(ql) {
  const out = [];
  for (const [key, label] of KEY_ACTIONS) if (matches(`${tr(label)} ${label}`, ql))
    out.push({ kind: "Command", label: `${tr(label)}  (${(keyMap[key] || key).toUpperCase()})`, run: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: keyMap[key] || key })) });
  for (const [id, label] of PALETTE_BUTTONS) if ($("#" + id) && matches(`${tr(label)} ${label}`, ql))
    out.push({ kind: "Command", label: tr(label), run: () => $("#" + id).click() });
  const fns = { Home: viewWholeMap, Invert: invertSelection, PasteInPlace: pasteInPlace };
  for (const [k, label] of PALETTE_KEYS) if (matches(`${tr(label)} ${label}`, ql)) out.push({ kind: "Command", label: tr(label), run: fns[k] });
  return out;
}
// "120 45" or "120, 45": world units x z; "tile 12 4": the middle of that tile
function paletteCoords(q) {
  const m = /^\s*(tile|kachel)?\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(q);
  if (!m || !root) return [];
  const tile = !!m[1];
  const x = tile ? +m[2] * 10 + 5 : +m[2], z = tile ? +m[3] * 10 + 5 : +m[3];
  return [{ kind: "Go to", label: `x ${x}  z ${z}` + (tile ? `  (${tr("tile")} ${m[2]},${m[3]})` : ""), run: () => flyTo(new THREE.Vector3(x, groundHeight(x, z) || 0, z), 40) }];
}
