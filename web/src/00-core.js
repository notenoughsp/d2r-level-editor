// D2R level editor: loads an HD preset (JSON entity list), renders terrain and models, and lets
// the user select (also several objects), move, rotate, scale, add, duplicate and delete entities,
// paint gameplay collision, and save/export/test the result through the local server.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { initI18n, locale, tr } from "./i18n.js?v=49";

initI18n();
const $ = (s) => document.querySelector(s);
const statusEl = $("#status");
let statusTimer = null;
const setStatus = (t) => {
  statusEl.textContent = t;
  try { const top = undoStack[undoStack.length - 1]; if (top && !top.label) top.label = t; } catch { /* during start-up */ }
  statusEl.classList.remove("old");
  clearTimeout(statusTimer);
  let fade = 8;
  try { fade = options.statusFade; } catch { /* during start-up */ }
  if (fade > 0) statusTimer = setTimeout(() => statusEl.classList.add("old"), fade * 1000);
};
const api = (path, params = {}) => `/api/${path}?` + new URLSearchParams(params).toString();
async function postJSON(path, params, body) {
  let res;
  try {
    res = await fetch(api(path, params), {
      method: "POST", headers: { "Content-Type": "application/json", "X-D2R-Editor": "1" },
      body: body === undefined ? "" : JSON.stringify(body),
    });
  } catch {
    serverLost();
    return { ok: false, data: { error: tr("No connection to the editor program") } };
  }
  return { ok: res.ok, data: await res.json().catch(() => ({ error: `HTTP ${res.status}` })) };
}

// ---------- three.js setup ----------
const viewport = $("#viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15130f);
scene.add(new THREE.HemisphereLight(0xfff4dd, 0x2a2418, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-80, 160, 60);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
camera.position.set(0, 120, 120);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
orbit.enableDamping = false;  // no mouse smoothing (can be switched on in the options)

const grid = new THREE.GridHelper(1000, 200, 0x3a3326, 0x221f19);
grid.position.y = -0.05; // below the terrain to avoid z-fighting
scene.add(grid);

// The gizmo moves an invisible pivot; the change is applied to every selected object, so the
// same code handles one and many objects.
const pivot = new THREE.Object3D();
scene.add(pivot);
const gizmo = new TransformControls(camera, renderer.domElement);
scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
new ResizeObserver(resize).observe(viewport); // the toolbar may wrap and change the viewport height
resize();
let frameLast = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now(), frameDt = Math.min(0.1, (now - frameLast) / 1000);  // seconds, any refresh rate
  frameLast = now;
  orbit.update();
  for (const b of selectionBoxes) b.update();
  keepMarkersUnscaled();
  renderer.render(scene, camera);
  updateFx();
  updateMixers();
  updateMapLights();
  updateFlight(frameDt);
  if (gameSelBox) gameSelBox.update();
  drawMinimap();
});
