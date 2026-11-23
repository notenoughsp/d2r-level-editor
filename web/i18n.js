// UI language (English / German). The editor is written in English; this module translates its
// texts into German in place: static HTML, every text set later (status line, panels, lists),
// tooltips, placeholders and the browser dialogs. Keys are the English texts, {0} {1} ... match
// variable parts.
const DE = {
  "{0} loaded": "{0} geladen", "Light": "Licht", "Effect": "Effekt", "Other": "Sonstiges",
  "Replacing failed: {0}": "Ersetzen fehlgeschlagen: {0}", "Replaced by {0}: {1} file(s)": "Ersetzt durch {0}: {1} Datei(en)",
  "Tile {0}, {1}": "Kachel {0}, {1}", "Biome: {0}": "Biom: {0}", "unsaved": "ungespeichert", "saved": "gespeichert",
  "{0} placed": "{0} platziert", "Game objects: {0}": "Spielobjekte: {0}", "The clipboard is empty": "Zwischenablage ist leer",
  "Draft autosaved ({0})": "Entwurf automatisch gesichert ({0})", "Export failed: {0}": "Export fehlgeschlagen: {0}",
  "NPC / monster": "NPC / Monster", "Object": "Objekt",
  "Version {0} is available (you have {1}).": "Version {0} ist verfügbar (du hast {1}).",
  "NPCs": "NPCs", "New NPC": "Neuer NPC", "Name": "Name", "Look": "Aussehen", "Role": "Rolle", "Talks": "Redet", "Trades": "Handelt",
  "talks": "redet", "trades": "handelt", "Goods of": "Waren von", "Save NPCs": "NPCs speichern", "Remove": "Entfernen",
  "Text (up to 6 lines, shown when the player talks to the NPC)": "Text (bis 6 Zeilen, erscheint wenn man mit dem NPC redet)",
  "New NPCs for the mod. Save, then place them in a map with \"Add game object\" (NPC list) and export.": "Neue NPCs für den Mod. Speichern, dann in einer Karte mit \"Spielobjekt hinzufügen\" (NPC-Liste) platzieren und exportieren.",
  "NPCs not saved: {0}": "NPCs nicht gespeichert: {0}",
  "NPCs saved; place them with Add game object, then export": "NPCs gespeichert; mit Spielobjekt hinzufügen platzieren, dann exportieren",
  "Update now": "Jetzt aktualisieren", "What's new": "Was ist neu", "Later": "Später",
  "Downloading update … {0} %": "Update wird geladen … {0} %", "Unpacking update …": "Update wird entpackt …",
  "Version {0} is ready. Save your work, then restart.": "Version {0} ist bereit. Speichere deine Arbeit, dann neu starten.",
  "Restart now": "Jetzt neu starten", "Restarting with version {0} …": "Neustart mit Version {0} …",
  "Update failed: {0}": "Update fehlgeschlagen: {0}",
  "The editor did not come back after the update. Please start it again.": "Der Editor kam nach dem Update nicht zurück. Bitte neu starten.",
  "Game object (DS1) · {0} · ID {1}": "Spielobjekt (DS1) · {0} · ID {1}",
  "Game object (DS1) · {0} · ID {1} · path with {2} points": "Spielobjekt (DS1) · {0} · ID {1} · Laufweg mit {2} Punkten",
  "x {0} z {1} · tile {2},{3}": "x {0} z {1} · Kachel {2},{3}",
  // own models and NPC stage texts
  "Own models (imported, recoloured)": "Eigene Modelle (importiert, umgefärbt)",
  "Recolour the model": "Modell umfärben",
  "A copy of the model in the preview with new textures; the original stays.": "Eine Kopie des Modells in der Vorschau mit neuen Texturen; das Original bleibt.",
  "Name of the copy (4 letters or digits)": "Name der Kopie (4 Buchstaben oder Ziffern)",
  "Kind": "Art",
  "Colour": "Farbe",
  "Strength": "Stärke",
  "Picture": "Bild",
  "Repeats": "Wiederholungen",
  "Material (tiling picture, e.g. CC0)": "Material (kachelndes Bild, z. B. CC0)",
  "Picture (stretched over the texture)": "Bild (über die Textur gelegt)",
  "Make the copy": "Kopie erstellen",
  "Import a 3D model": "3D-Modell importieren",
  "OBJ or glTF (.glb) mesh, becomes a new game model (data/hd/env/model/custom/).": "OBJ- oder glTF-Mesh (.glb), wird ein neues Spielmodell (data/hd/env/model/custom/).",
  "Mesh": "Mesh",
  "Texture (optional)": "Textur (optional)",
  "Height (units, 10 = 1 tile)": "Höhe (Einheiten, 10 = 1 Kachel)",
  "e.g. my_statue": "z. B. meine_statue",
  "Import": "Importieren",
  "Texts by quest stage": "Texte nach Quest-Stufe",
  "For quest mods (World Waypoints quests): from the given quest stage on, the NPC says this text instead.": "Für Quest-Mods (World-Waypoints-Quests): ab der angegebenen Quest-Stufe sagt der NPC stattdessen diesen Text.",
  "Add a stage text": "Stufen-Text hinzufügen",
  "From quest stage": "Ab Quest-Stufe",
  "Choose a model in the list first": "Erst ein Modell in der Liste wählen",
  "Choose a picture first": "Erst ein Bild wählen",
  "Choose a mesh file first": "Erst eine Mesh-Datei wählen",
  "Recolouring …": "Wird umgefärbt …",
  "Recolouring failed: {0}": "Umfärben fehlgeschlagen: {0}",
  "New model {0} ({1} texture(s))": "Neues Modell {0} ({1} Textur(en))",
  "Importing …": "Wird importiert …",
  "Import failed: {0}": "Import fehlgeschlagen: {0}",
  "Imported {0}: {1} vertices, {2} triangles": "Importiert {0}: {1} Eckpunkte, {2} Dreiecke",
  "Model name: 2-40 small letters, digits or _": "Modellname: 2-40 kleine Buchstaben, Ziffern oder _",
  "Mesh file: .obj or .glb": "Mesh-Datei: .obj oder .glb",
  "The mesh file is empty or too large (60 MB at most).": "Die Mesh-Datei ist leer oder zu groß (höchstens 60 MB).",
  "The picture is too large (40 MB at most).": "Das Bild ist zu groß (höchstens 40 MB).",
  "Choose a game model first.": "Erst ein Spielmodell wählen.",
  "Name: four letters or digits, e.g. gold": "Name: vier Buchstaben oder Ziffern, z. B. gold",
  "Model not found: only game models can be recoloured (not copies made by the editor).": "Modell nicht gefunden: nur Spielmodelle können umgefärbt werden (keine Kopien aus dem Editor).",
  // messages from the editor server
  "Size does not match: {0} instead of {1} tiles": "Größe passt nicht: {0} statt {1} Kacheln",
  "The game objects of this DS1 file cannot be edited.": "Die Objekte dieser DS1-Datei können nicht bearbeitet werden.",
  "This DS1 file cannot be written back without loss; edit refused.": "Diese DS1-Datei kann nicht verlustfrei geschrieben werden; Bearbeitung abgelehnt.",
  "A test is already running.": "Ein Test läuft bereits.",
  "Game object outside the map: subtile {0}, {1} (map: {2} x {3})": "Spielobjekt außerhalb der Karte: Subtile {0}, {1} (Karte: {2} x {3})",
  "The mod folder is in use (is the game running?); close the game and export again.": "Der Mod-Ordner ist in Benutzung (läuft das Spiel?); Spiel schließen und erneut exportieren.",
  "Mod name: only letters, digits, _ and -": "Mod-Name: nur Buchstaben, Ziffern, _ und -",
  "Test failed: {0}": "Test fehlgeschlagen: {0}",
  "Save": "Speichern",
  "Undo": "Rückgängig",
  "Redo": "Wiederholen",
  "Move": "Verschieben",
  "Rotate": "Drehen",
  "Scale": "Skalieren",
  "Top view": "Draufsicht",
  "T: top view on/off": "T: Draufsicht ein/aus",
  "Snap": "Raster",
  "Snap when moving, rotating and scaling": "Einrasten beim Verschieben, Drehen und Skalieren",
  "Move snap (units, 10 = 1 tile)": "Raster Verschieben (Einheiten, 10 = 1 Kachel)",
  "Rotation snap (degrees)": "Raster Drehen (Grad)",
  "Scale snap": "Raster Skalieren",
  "Collision": "Kollision",
  "Game objects": "Spielobjekte",
  "Helpers": "Hilfen",
  "Game objects from the DS1: NPCs, monster spawns, chests, waypoints": "Spielobjekte aus der DS1: NPCs, Monster-Spawns, Truhen, Wegpunkte",
  "Show lights, effects, sounds and other invisible objects as symbols": "Lichter, Effekte, Sounds und andere unsichtbare Objekte als Symbole zeigen",
  "Tool": "Werkzeug",
  "Objects": "Objekte",
  "Collision: block": "Kollision: sperren",
  "Collision: block + teleport": "Kollision: sperren + Teleport",
  "Collision: clear": "Kollision: freimachen",
  "Collision: original": "Kollision: Original",
  "Subtile: block": "Subtile: sperren",
  "Subtile: block + teleport": "Subtile: sperren + Teleport",
  "Subtile: clear": "Subtile: freigeben",
  "All 128 subtile patterns are in use.": "Alle 128 Subtile-Muster sind belegt.",
  "Collision brush size": "Pinselgröße für Kollision",
  "Write all saved maps into the game folder as a mod": "Alle gespeicherten Karten als Mod in den Spielordner schreiben",
  "Test in game": "Im Spiel testen",
  "Export and test automatically in the game (second monitor, muted)": "Exportieren und automatisch im Spiel testen (zweiter Monitor, stumm)",
  "Language": "Sprache",
  "Ctrl+S": "Strg+S",
  "Ctrl+Z": "Strg+Z",
  "Ctrl+Y": "Strg+Y",
  "Maps": "Karten",
  "Models": "Modelle",
  "Search maps, e.g. act1/town": "Karte suchen, z. B. act1/town",
  "Search objects of the map, e.g. palisade, light": "Objekte der Karte suchen, z. B. palisade, light",
  "Search models, e.g. palisade, tree, barrel": "Modell suchen, z. B. palisade, tree, barrel",
  "Area": "Bereich",
  "All areas": "Alle Bereiche",
  "Recently used": "Zuletzt benutzt",
  "Act {0}": "Akt {0}",
  "Plants": "Pflanzen",
  "Characters": "Figuren",
  "Click = preview · double-click = place in the view centre · P = place at the mouse cursor": "Klick = Vorschau · Doppelklick = in der Bildmitte platzieren · P = am Mauszeiger platzieren",
  "{0} models": "{0} Modelle",
  "{0} models (first {1})": "{0} Modelle (erste {1})",
  "{0} map presets available": "{0} Karten-Presets verfügbar",
  "{0} objects": "{0} Objekte",
  "{0} objects, {1} matching": "{0} Objekte, {1} passend",
  "Loading {0} …": "Lade {0} …",
  "Could not load the model": "Modell konnte nicht geladen werden",
  "Loading models: {0} / {1}": "Modelle laden: {0} / {1}",
  "Selection": "Auswahl",
  "Nothing selected": "Nichts ausgewählt",
  "Add game object": "Spielobjekt hinzufügen",
  "NPC / monster": "NPC / Monster",
  "Object": "Objekt",
  "Add": "Hinzufügen",
  "O: add at the mouse cursor": "O: am Mauszeiger hinzufügen",
  "Map": "Karte",
  "Controls": "Steuerung",
  "Duplicate": "Duplizieren",
  "Delete": "Löschen",
  "Drop to ground": "Auf den Boden",
  "G: put onto the terrain height": "G: auf die Geländehöhe setzen",
  "Random rotation": "Zufällig drehen",
  "Turn at random around the vertical axis (looks natural for plants and rocks)": "Zufällig um die Hochachse drehen (natürlicher bei Pflanzen und Steinen)",
  "Collision under object": "Kollision unter Objekt",
  "Block the tiles under the object; the blocked area moves with the object": "Kacheln unter dem Objekt sperren; die Sperrfläche wandert mit dem Objekt",
  "{0} objects selected": "{0} Objekte ausgewählt",
  "Prefab: {0}": "Prefab: {0}",
  "(no model)": "(kein Modell)",
  "({0})": "({0})",
  "Linked collision: {0} tile(s)": "Kollision verknüpft: {0} Kachel(n)",
  "Explode prefab": "Prefab auflösen",
  "Replace the prefab with its single objects so they can be edited one by one (on this map only)": "Prefab durch seine einzelnen Objekte ersetzen, damit sie einzeln bearbeitbar sind (nur auf dieser Karte)",
  "Position": "Position",
  "Rotation°": "Drehung°",
  "Scaling": "Skalierung",
  "Game object (DS1) · {0} · ID {1}": "Spielobjekt (DS1) · {0} · ID {1}",
  "Game object (DS1) · {0} · ID {1} · path with {2} points": "Spielobjekt (DS1) · {0} · ID {1} · Laufweg mit {2} Punkten",
  "Type": "Typ",
  "This DS1 does not allow object changes.": "Diese DS1 erlaubt keine Objektänderungen.",
  "{0} objects: {1} models, {2} helper objects": "{0} Objekte: {1} Modelle, {2} Hilfsobjekte",
  "Biome: {0}": "Biom: {0}",
  "unsaved": "ungespeichert",
  "saved": "gespeichert",
  "Game objects: {0}": "Spielobjekte: {0}",
  "Close": "Schließen",
  "Hide": "Ausblenden",
  "Light": "Licht",
  "Effect": "Effekt",
  "Sound": "Sound",
  "Terrain stamp": "Gelände-Stempel",
  "Decal": "Decal",
  "Other": "Sonstiges",
  "Terrain": "Gelände",
  "Prefab": "Prefab",
  "Model": "Modell",
  "Left click: select · Shift+click: add to/remove from the selection · drag with the left mouse button: box selection · Esc: deselect": "Linksklick: auswählen · Shift+Klick: zur Auswahl hinzufügen/entfernen · Linke Maus ziehen: Rahmenauswahl · Esc: Auswahl aufheben",
  "Ctrl+C/Ctrl+V: copy/paste (at the mouse cursor, also into other maps) · arrow keys: move one snap step (Shift ×10), Page Up/Down: height · G: drop to ground · T: top view · O: add a game object at the mouse cursor": "Strg+C/Strg+V: kopieren/einfügen (am Mauszeiger, auch in andere Karten) · Pfeiltasten: um einen Rasterschritt schieben (Shift ×10), Bild↑/Bild↓: Höhe · G: auf den Boden setzen · T: Draufsicht · O: Spielobjekt am Mauszeiger hinzufügen",
  "Game objects (from the DS1, used by the game): red cones = NPCs/monsters (line = walking path), turquoise cubes = objects. Select, drag, change the type and delete them like other objects.": "Spielobjekte (aus der DS1, im Spiel wirksam): rote Kegel = NPCs/Monster (Linie = Laufweg), türkise Würfel = Objekte. Auswählen, ziehen, Typ ändern, löschen wie andere Objekte.",
  "Right mouse: orbit · middle mouse: pan · wheel: zoom": "Rechte Maus: drehen · Mittlere Maus: verschieben · Rad: zoomen",
  "W/E/R: move/rotate/scale · Del: delete · Ctrl+D: duplicate · Ctrl+Z/Ctrl+Y: undo/redo · F: focus the selection · P: place the preview model at the mouse cursor": "W/E/R: Verschieben/Drehen/Skalieren · Entf: löschen · Strg+D: duplizieren · Strg+Z/Strg+Y: rückgängig/wiederholen · F: Auswahl fokussieren · P: Modell aus der Vorschau am Mauszeiger platzieren",
  "Collision: choose a tool, then paint tiles (10×10 units) with left click/drag. Red = not walkable, blue = blocks only line of sight, yellow border = changed by you. \"Collision under object\" links the blocked area to the object: it moves along and disappears when the object is deleted.": "Kollision: Werkzeug wählen, dann mit Linksklick/Ziehen Kacheln (10×10 Einheiten) bemalen. Rot = nicht begehbar, Blau = nur Sicht blockiert, gelber Rand = von dir geändert. „Kollision unter Objekt“ verknüpft die Sperrfläche mit dem Objekt: Sie wandert beim Verschieben mit und verschwindet beim Löschen.",
  "Discard unsaved changes?": "Ungespeicherte Änderungen verwerfen?",
  "Could not load the map: {0}": "Karte konnte nicht geladen werden: {0}",
  "There is an autosaved, unsaved draft of this map from {0}. Restore it?": "Für diese Karte gibt es einen automatisch gesicherten, ungespeicherten Entwurf vom {0}. Wiederherstellen?",
  "Loading entities {0}/{1} …": "Lade Entitäten {0}/{1} …",
  "Nothing to undo": "Nichts rückgängig zu machen",
  "Undone": "Rückgängig gemacht",
  "Nothing to redo": "Nichts zu wiederholen",
  "Redone": "Wiederholt",
  "Open a map first.": "Zuerst eine Karte öffnen.",
  "{0} object(s) deleted": "{0} Objekt(e) gelöscht",
  "Saved: {0}": "Gespeichert: {0}",
  "Error while saving: {0}": "Fehler beim Speichern: {0}",
  "Collision saved ({0} tile(s)) in {1}": "Kollision gespeichert ({0} Kachel(n)) in {1}",
  "Collision: {0}": "Kollision: {0}",
  "These tiles are already blocked": "Diese Kacheln sind schon gesperrt",
  "Mod name (folder under mods\\):": "Name des Mods (Ordner unter mods\\):",
  "The current map has unsaved changes. Save first?": "Die aktuelle Karte hat ungespeicherte Änderungen. Erst speichern?",
  "Test: {0}": "Test: {0}",
  "In-game test running (second monitor, muted) … {0} s": "Test im Spiel läuft (zweiter Monitor, stumm) … {0} s",
  "In-game test: problems found": "Test im Spiel: Fehler gefunden",
  "In-game test: all passed": "Test im Spiel: alles bestanden",
  "In-game test – mod {0}": "Test im Spiel – Mod {0}",
  "(no report)": "(kein Bericht)",
  "Prefab exploded: {0} objects": "Prefab aufgelöst: {0} Objekte",
  "Note: this map piece is a reusable building block ({0}). Random areas can place it several times – changes show up at every one of those places.": "Achtung: Dieses Kartenstück ist ein wiederverwendbarer Baustein ({0}). Zufallsgebiete können es mehrfach einsetzen – Änderungen erscheinen an jeder dieser Stellen.",
  "Own map piece of: {0}.": "Eigenes Kartenstück von: {0}.",
  "Own map piece of: {0} – one of {1} variants; the game picks one by seed (always the same with a fixed seed).": "Eigenes Kartenstück von: {0} – eine von {1} Varianten; das Spiel wählt sie per Seed (mit festem Seed immer dieselbe).",
  "Game objects saved": "Spielobjekte gespeichert",
  "This map has no editable game objects": "Diese Karte hat keine bearbeitbaren Spielobjekte",
  "{0} object(s) dropped to the ground": "{0} Objekt(e) auf den Boden gesetzt",
  "Rotated at random": "Zufällig gedreht",
  "{0} object(s) copied": "{0} Objekt(e) kopiert",
  "The clipboard is empty": "Zwischenablage ist leer",
  "{0} object(s) pasted": "{0} Objekt(e) eingefügt",
  "{0} object(s) in the box": "{0} Objekt(e) im Rahmen",
  "Draft autosaved ({0})": "Entwurf automatisch gesichert ({0})",
  "The level of detail reloads the map. Discard unsaved changes?": "Die Detailstufe lädt die Karte neu. Ungespeicherte Änderungen verwerfen?",
  "The current map has unsaved changes. Export anyway (saved work only)?": "Die aktuelle Karte hat ungespeicherte Änderungen. Trotzdem exportieren (nur Gespeichertes)?",
  "Exported: {0} file(s) to {1}": "Exportiert: {0} Datei(en) nach {1}",
  "Export failed: {0}": "Export fehlgeschlagen: {0}",
  "{0} loaded": "{0} geladen",
  "Legacy graphics": "Alte Grafik",
  "Switch between the HD view and the legacy graphics (SD tiles as in the original game)": "Umschalten zwischen HD-Ansicht und alter Grafik (SD-Kacheln wie im Originalspiel)",
  "Legacy graphics (SD) · wheel: zoom · drag: pan · double-click: show this place in the HD view": "Alte Grafik (SD) · Rad: zoomen · Ziehen: verschieben · Doppelklick: diese Stelle in der HD-Ansicht zeigen",
  "Drawing the legacy graphics …": "Alte Grafik wird gezeichnet …",
  "Tile {0}, {1}": "Kachel {0}, {1}",
  "Apply": "Übernehmen",
  "Take over a map of the same size … ({0}, experimental)": "Inhalt einer Karte gleicher Größe übernehmen … ({0}, experimentell)",
  "Take over a map of the same size … (experimental)": "Inhalt einer Karte gleicher Größe übernehmen … (experimentell)",
  "Replaces this map with a copy of another map of the same size (tiles, collision, game objects, models, terrain). The game uses it at this place.": "Ersetzt diese Karte durch eine Kopie einer anderen Karte gleicher Größe (Kacheln, Kollision, Spielobjekte, Modelle, Gelände). Das Spiel benutzt sie an dieser Stelle.",
  "{0} will be replaced by a copy of {1}. Continue?": "{0} wird durch eine Kopie von {1} ersetzt. Fortfahren?",
  "Replacing failed: {0}": "Ersetzen fehlgeschlagen: {0}",
  "Replaced by {0}: {1} file(s)": "Ersetzt durch {0}: {1} Datei(en)",
  "Game object added": "Spielobjekt hinzugefügt",
  "Game object deleted": "Spielobjekt gelöscht",
};

const norm = (s) => s.replace(/\s+/g, " ").trim();
const exact = new Map();
const patterns = [];
for (const [en, de] of Object.entries(DE)) {
  const key = norm(en);
  if (!/\{\d\}/.test(key)) exact.set(key, de);
  else {
    const rx = new RegExp("^" + key.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{(\d)\\?\}/g, "(.+?)") + "$");
    const order = [...key.matchAll(/\{(\d)\}/g)].map((m) => +m[1]);
    patterns.push([rx, order, de, key.length]);
  }
}
patterns.sort((a, b) => b[3] - a[3]);  // most specific (longest) pattern first

export let lang = localStorage.getItem("lang") || (navigator.language.toLowerCase().startsWith("de") ? "de" : "en");
export const locale = () => (lang === "de" ? "de-DE" : "en-GB");

/** English UI text -> current language (unknown texts stay as they are). */
export const tr = (text) => translate(text, lang);

function translate(text, to) {
  if (to === "en" || typeof text !== "string") return text;
  const key = norm(text);
  if (!key) return text;
  const hit = exact.get(key);
  if (hit !== undefined) return keepSpace(text, hit);
  for (const [rx, order, de] of patterns) {
    const m = key.match(rx);
    if (m) {
      const vals = {};
      order.forEach((n, i) => { vals[n] = translate(m[i + 1], to); });
      return keepSpace(text, de.replace(/\{(\d)\}/g, (_, n) => vals[n]));
    }
  }
  return text;
}
const keepSpace = (orig, out) => (/^\s/.test(orig) ? " " : "") + out + (/\s$/.test(orig) ? " " : "");

// A shown text is "known" when it is the remembered English original or its German form.
const known = (shown, en) => shown === en || shown === translate(en, "de");

// Remembered English originals, so switching back restores them.
const origText = new WeakMap();
const origAttr = new WeakMap();
const ATTRS = ["title", "placeholder"];

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const p = node.parentNode;
    if (!p || p.nodeName === "SCRIPT" || p.nodeName === "STYLE") return;
    let en = origText.get(node);
    if (en === undefined || !known(node.nodeValue, en)) en = node.nodeValue;  // text set by the editor
    origText.set(node, en);
    const want = tr(en);
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
