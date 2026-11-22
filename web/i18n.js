// UI language (German / English). The editor is written with German texts; this module translates
// them in place: static HTML, every text set later (status line, panels, lists), tooltips,
// placeholders and the browser dialogs. Keys are the German texts, {0} {1} ... match variable parts.
const EN = {
  // toolbar
  "Speichern": "Save", "Rückgängig": "Undo", "Wiederholen": "Redo", "Verschieben": "Move", "Drehen": "Rotate",
  "Skalieren": "Scale", "Draufsicht": "Top view", "T: Draufsicht ein/aus": "T: top view on/off", "Raster": "Snap",
  "Einrasten beim Verschieben, Drehen und Skalieren": "Snap when moving, rotating and scaling",
  "Raster Verschieben (Einheiten, 10 = 1 Kachel)": "Move snap (units, 10 = 1 tile)",
  "Raster Drehen (Grad)": "Rotation snap (degrees)", "Raster Skalieren": "Scale snap",
  "Kollision": "Collision", "Spielobjekte": "Game objects", "Hilfen": "Helpers",
  "Spielobjekte aus der DS1: NPCs, Monster-Spawns, Truhen, Wegpunkte": "Game objects from the DS1: NPCs, monster spawns, chests, waypoints",
  "Lichter, Effekte, Sounds und andere unsichtbare Objekte als Symbole zeigen": "Show lights, effects, sounds and other invisible objects as symbols",
  "Werkzeug": "Tool", "Objekte": "Objects", "Kollision: sperren": "Collision: block",
  "Kollision: sperren + Teleport": "Collision: block + teleport", "Kollision: freimachen": "Collision: clear",
  "Kollision: Original": "Collision: original", "Subtile: sperren": "Subtile: block",
  "Subtile: sperren + Teleport": "Subtile: block + teleport", "Subtile: freigeben": "Subtile: clear",
  "Alle 128 Subtile-Muster sind belegt.": "All 128 subtile patterns are in use.", "Pinselgröße für Kollision": "Collision brush size",
  "Alle gespeicherten Karten als Mod in den Spielordner schreiben": "Write all saved maps into the game folder as a mod",
  "Im Spiel testen": "Test in game",
  "Exportieren und automatisch im Spiel testen (zweiter Monitor, stumm)": "Export and test automatically in the game (second monitor, muted)",
  "Sprache": "Language", "Strg+S": "Ctrl+S", "Strg+Z": "Ctrl+Z", "Strg+Y": "Ctrl+Y",
  // left panel
  "Karten": "Maps", "Modelle": "Models", "Karte suchen, z. B. act1/town": "Search maps, e.g. act1/town",
  "Objekte der Karte suchen, z. B. palisade, light": "Search objects of the map, e.g. palisade, light",
  "Modell suchen, z. B. palisade, tree, barrel": "Search models, e.g. palisade, tree, barrel",
  "Bereich": "Area", "Alle Bereiche": "All areas", "Zuletzt benutzt": "Recently used", "Akt {0}": "Act {0}",
  "Pflanzen": "Plants", "Figuren": "Characters",
  "Klick = Vorschau · Doppelklick = in der Bildmitte platzieren · P = am Mauszeiger platzieren":
    "Click = preview · double-click = place in the view centre · P = place at the mouse cursor",
  "{0} Modelle": "{0} models", "{0} Modelle (erste {1})": "{0} models (first {1})",
  "{0} Karten-Presets verfügbar": "{0} map presets available", "{0} Objekte": "{0} objects",
  "{0} Objekte, {1} passend": "{0} objects, {1} matching",
  "Lade {0} …": "Loading {0} …", "Modell konnte nicht geladen werden": "Could not load the model",
  "Modelle laden: {0} / {1}": "Loading models: {0} / {1}",
  // right panel
  "Auswahl": "Selection", "Nichts ausgewählt": "Nothing selected", "Spielobjekt hinzufügen": "Add game object",
  "NPC / Monster": "NPC / monster", "Objekt": "Object", "Hinzufügen": "Add",
  "O: am Mauszeiger hinzufügen": "O: add at the mouse cursor", "Karte": "Map", "Steuerung": "Controls",
  "Duplizieren": "Duplicate", "Löschen": "Delete", "Auf den Boden": "Drop to ground",
  "G: auf die Geländehöhe setzen": "G: put onto the terrain height", "Zufällig drehen": "Random rotation",
  "Zufällig um die Hochachse drehen (natürlicher bei Pflanzen und Steinen)": "Turn at random around the vertical axis (looks natural for plants and rocks)",
  "Kollision unter Objekt": "Collision under object",
  "Kacheln unter dem Objekt sperren; die Sperrfläche wandert mit dem Objekt": "Block the tiles under the object; the blocked area moves with the object",
  "{0} Objekte ausgewählt": "{0} objects selected", "Prefab: {0}": "Prefab: {0}", "(kein Modell)": "(no model)",
  "({0})": "({0})", "Kollision verknüpft: {0} Kachel(n)": "Linked collision: {0} tile(s)",
  "Prefab auflösen": "Explode prefab",
  "Prefab durch seine einzelnen Objekte ersetzen, damit sie einzeln bearbeitbar sind (nur auf dieser Karte)":
    "Replace the prefab with its single objects so they can be edited one by one (on this map only)",
  "Position": "Position", "Drehung°": "Rotation°", "Skalierung": "Scale",
  "Spielobjekt (DS1) · {0} · ID {1}": "Game object (DS1) · {0} · ID {1}",
  "Spielobjekt (DS1) · {0} · ID {1} · Laufweg mit {2} Punkten": "Game object (DS1) · {0} · ID {1} · path with {2} points",
  "Typ": "Type", "Diese DS1 erlaubt keine Objektänderungen.": "This DS1 does not allow object changes.",
  "{0} Objekte: {1} Modelle, {2} Hilfsobjekte": "{0} objects: {1} models, {2} helper objects",
  "Biom: {0}": "Biome: {0}", "ungespeichert": "unsaved", "gespeichert": "saved", "Spielobjekte: {0}": "Game objects: {0}",
  "Schließen": "Close", "Ausblenden": "Hide",
  // object kinds
  "Licht": "Light", "Effekt": "Effect", "Sound": "Sound", "Gelände-Stempel": "Terrain stamp", "Decal": "Decal",
  "Sonstiges": "Other", "Gelände": "Terrain", "Prefab": "Prefab", "Modell": "Model",
  // help text
  "Linksklick: auswählen · Shift+Klick: zur Auswahl hinzufügen/entfernen · Linke Maus ziehen: Rahmenauswahl · Esc: Auswahl aufheben":
    "Left click: select · Shift+click: add to/remove from the selection · drag with the left mouse button: box selection · Esc: deselect",
  "Strg+C/Strg+V: kopieren/einfügen (am Mauszeiger, auch in andere Karten) · Pfeiltasten: um einen Rasterschritt schieben (Shift ×10), Bild↑/Bild↓: Höhe · G: auf den Boden setzen · T: Draufsicht · O: Spielobjekt am Mauszeiger hinzufügen":
    "Ctrl+C/Ctrl+V: copy/paste (at the mouse cursor, also into other maps) · arrow keys: move one snap step (Shift ×10), Page Up/Down: height · G: drop to ground · T: top view · O: add a game object at the mouse cursor",
  "Spielobjekte (aus der DS1, im Spiel wirksam): rote Kegel = NPCs/Monster (Linie = Laufweg), türkise Würfel = Objekte. Auswählen, ziehen, Typ ändern, löschen wie andere Objekte.":
    "Game objects (from the DS1, used by the game): red cones = NPCs/monsters (line = walking path), turquoise cubes = objects. Select, drag, change the type and delete them like other objects.",
  "Rechte Maus: drehen · Mittlere Maus: verschieben · Rad: zoomen": "Right mouse: orbit · middle mouse: pan · wheel: zoom",
  "W/E/R: Verschieben/Drehen/Skalieren · Entf: löschen · Strg+D: duplizieren · Strg+Z/Strg+Y: rückgängig/wiederholen · F: Auswahl fokussieren · P: Modell aus der Vorschau am Mauszeiger platzieren":
    "W/E/R: move/rotate/scale · Del: delete · Ctrl+D: duplicate · Ctrl+Z/Ctrl+Y: undo/redo · F: focus the selection · P: place the preview model at the mouse cursor",
  "Kollision: Werkzeug wählen, dann mit Linksklick/Ziehen Kacheln (10×10 Einheiten) bemalen. Rot = nicht begehbar, Blau = nur Sicht blockiert, gelber Rand = von dir geändert. „Kollision unter Objekt“ verknüpft die Sperrfläche mit dem Objekt: Sie wandert beim Verschieben mit und verschwindet beim Löschen.":
    "Collision: choose a tool, then paint tiles (10×10 units) with left click/drag. Red = not walkable, blue = blocks only line of sight, yellow border = changed by you. \"Collision under object\" links the blocked area to the object: it moves along and disappears when the object is deleted.",
  // status line and dialogs
  "Ungespeicherte Änderungen verwerfen?": "Discard unsaved changes?",
  "Karte konnte nicht geladen werden: {0}": "Could not load the map: {0}",
  "Für diese Karte gibt es einen automatisch gesicherten, ungespeicherten Entwurf vom {0}. Wiederherstellen?":
    "There is an autosaved, unsaved draft of this map from {0}. Restore it?",
  "Lade Entitäten {0}/{1} …": "Loading entities {0}/{1} …",
  "Nichts rückgängig zu machen": "Nothing to undo", "Rückgängig gemacht": "Undone",
  "Nichts zu wiederholen": "Nothing to redo", "Wiederholt": "Redone", "Zuerst eine Karte öffnen.": "Open a map first.",
  "{0} Objekt(e) gelöscht": "{0} object(s) deleted", "Gespeichert: {0}": "Saved: {0}",
  "Fehler beim Speichern: {0}": "Error while saving: {0}",
  "Kollision gespeichert ({0} Kachel(n)) in {1}": "Collision saved ({0} tile(s)) in {1}", "Kollision: {0}": "Collision: {0}",
  "Diese Kacheln sind schon gesperrt": "These tiles are already blocked",
  "Name des Mods (Ordner unter mods\\):": "Mod name (folder under mods\\):",
  "Die aktuelle Karte hat ungespeicherte Änderungen. Erst speichern?": "The current map has unsaved changes. Save first?",
  "Test: {0}": "Test: {0}", "Test im Spiel läuft (zweiter Monitor, stumm) … {0} s": "In-game test running (second monitor, muted) … {0} s",
  "Test im Spiel: Fehler gefunden": "In-game test: problems found", "Test im Spiel: alles bestanden": "In-game test: all passed",
  "Test im Spiel – Mod {0}": "In-game test – mod {0}", "(kein Bericht)": "(no report)",
  "Prefab aufgelöst: {0} Objekte": "Prefab exploded: {0} objects",
  "Achtung: Dieses Kartenstück ist ein wiederverwendbarer Baustein ({0}). Zufallsgebiete können es mehrfach einsetzen – Änderungen erscheinen an jeder dieser Stellen.":
    "Note: this map piece is a reusable building block ({0}). Random areas can place it several times – changes show up at every one of those places.",
  "Eigenes Kartenstück von: {0}.": "Own map piece of: {0}.",
  "Eigenes Kartenstück von: {0} – eine von {1} Varianten; das Spiel wählt sie per Seed (mit festem Seed immer dieselbe).":
    "Own map piece of: {0} – one of {1} variants; the game picks one by seed (always the same with a fixed seed).",
  "Spielobjekte gespeichert": "Game objects saved", "Diese Karte hat keine bearbeitbaren Spielobjekte": "This map has no editable game objects",
  "{0} Objekt(e) auf den Boden gesetzt": "{0} object(s) dropped to the ground", "Zufällig gedreht": "Rotated at random",
  "{0} Objekt(e) kopiert": "{0} object(s) copied", "Zwischenablage ist leer": "The clipboard is empty",
  "{0} Objekt(e) eingefügt": "{0} object(s) pasted", "{0} Objekt(e) im Rahmen": "{0} object(s) in the box",
  "Entwurf automatisch gesichert ({0})": "Draft autosaved ({0})",
  "Die Detailstufe lädt die Karte neu. Ungespeicherte Änderungen verwerfen?": "The level of detail reloads the map. Discard unsaved changes?",
  "Die aktuelle Karte hat ungespeicherte Änderungen. Trotzdem exportieren (nur Gespeichertes)?":
    "The current map has unsaved changes. Export anyway (saved work only)?",
  "Exportiert: {0} Datei(en) nach {1}": "Exported: {0} file(s) to {1}", "Export fehlgeschlagen: {0}": "Export failed: {0}",
  "{0} geladen": "{0} loaded", "Alte Grafik": "Legacy graphics",
  "Umschalten zwischen HD-Ansicht und alter Grafik (SD-Kacheln wie im Originalspiel)": "Switch between the HD view and the legacy graphics (SD tiles as in the original game)",
  "Alte Grafik (SD) · Rad: zoomen · Ziehen: verschieben · Doppelklick: diese Stelle in der HD-Ansicht zeigen": "Legacy graphics (SD) · wheel: zoom · drag: pan · double-click: show this place in the HD view",
  "Alte Grafik wird gezeichnet …": "Drawing the legacy graphics …", "Kachel {0}, {1}": "Tile {0}, {1}", "Übernehmen": "Apply",
  "Inhalt einer Karte gleicher Größe übernehmen … ({0}, experimentell)": "Take over a map of the same size … ({0}, experimental)",
  "Inhalt einer Karte gleicher Größe übernehmen … (experimentell)": "Take over a map of the same size … (experimental)",
  "Ersetzt diese Karte durch eine Kopie einer anderen Karte gleicher Größe (Kacheln, Kollision, Spielobjekte, Modelle, Gelände). Das Spiel benutzt sie an dieser Stelle.":
    "Replaces this map with a copy of another map of the same size (tiles, collision, game objects, models, terrain). The game uses it at this place.",
  "{0} wird durch eine Kopie von {1} ersetzt. Fortfahren?": "{0} will be replaced by a copy of {1}. Continue?",
  "Ersetzen fehlgeschlagen: {0}": "Replacing failed: {0}", "Ersetzt durch {0}: {1} Datei(en)": "Replaced by {0}: {1} file(s)", "Spielobjekt hinzugefügt": "Game object added", "Spielobjekt gelöscht": "Game object deleted",
};

const norm = (s) => s.replace(/\s+/g, " ").trim();
const exact = new Map();
const patterns = [];
for (const [de, en] of Object.entries(EN)) {
  const key = norm(de);
  if (!/\{\d\}/.test(key)) exact.set(key, en);
  else {
    const rx = new RegExp("^" + key.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{(\d)\\?\}/g, "(.+?)") + "$");
    const order = [...key.matchAll(/\{(\d)\}/g)].map((m) => +m[1]);
    patterns.push([rx, order, en, key.length]);
  }
}
patterns.sort((a, b) => b[3] - a[3]);  // most specific (longest) pattern first

export let lang = localStorage.getItem("lang") || (navigator.language.toLowerCase().startsWith("de") ? "de" : "en");
export const locale = () => (lang === "de" ? "de-DE" : "en-GB");

/** German UI text -> current language (unknown texts stay as they are). */
export const tr = (text) => translate(text, lang);

function translate(text, to) {
  if (to === "de" || typeof text !== "string") return text;
  const key = norm(text);
  if (!key) return text;
  const hit = exact.get(key);
  if (hit !== undefined) return keepSpace(text, hit);
  for (const [rx, order, en] of patterns) {
    const m = key.match(rx);
    if (m) {
      const vals = {};
      order.forEach((n, i) => { vals[n] = translate(m[i + 1], to); });
      return keepSpace(text, en.replace(/\{(\d)\}/g, (_, n) => vals[n]));
    }
  }
  return text;
}
const keepSpace = (orig, out) => (/^\s/.test(orig) ? " " : "") + out + (/\s$/.test(orig) ? " " : "");

// A shown text is "known" when it is the remembered German original or its English form.
const known = (shown, de) => shown === de || shown === translate(de, "en");

// Remembered German originals, so switching back restores them.
const origText = new WeakMap();
const origAttr = new WeakMap();
const ATTRS = ["title", "placeholder"];

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const p = node.parentNode;
    if (!p || p.nodeName === "SCRIPT" || p.nodeName === "STYLE") return;
    let de = origText.get(node);
    if (de === undefined || !known(node.nodeValue, de)) de = node.nodeValue;  // text set by the editor
    origText.set(node, de);
    const want = tr(de);
    if (node.nodeValue !== want) node.nodeValue = want;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  let saved = origAttr.get(node);
  for (const a of ATTRS) {
    if (!node.hasAttribute(a)) continue;
    const cur = node.getAttribute(a);
    if (!saved) origAttr.set(node, (saved = {}));
    if (saved[a] === undefined || !known(cur, saved[a])) saved[a] = cur;
    const want = tr(saved[a]);
    if (cur !== want) node.setAttribute(a, want);
  }
  for (const c of node.childNodes) translateNode(c);
}

let applying = false;
const observer = new MutationObserver((list) => {
  if (applying) return;
  applying = true;
  for (const m of list) {
    if (m.type === "characterData") translateNode(m.target);
    else if (m.type === "attributes") translateNode(m.target);
    else m.addedNodes.forEach(translateNode);
  }
  observer.takeRecords();
  applying = false;
});

export function setLang(l) {
  lang = l;
  localStorage.setItem("lang", l);
  document.documentElement.lang = l;
  applying = true;
  translateNode(document.body);
  document.title = tr(document.title);
  observer.takeRecords();
  applying = false;
}

// Browser dialogs get translated texts as well.
for (const fn of ["alert", "confirm", "prompt"]) {
  const orig = window[fn].bind(window);
  window[fn] = (msg, ...rest) => orig(tr(msg), ...rest);
}

export function initI18n() {
  const sel = document.getElementById("lang");
  if (sel) {
    sel.value = lang;
    sel.addEventListener("change", () => setLang(sel.value));
  }
  setLang(lang);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
