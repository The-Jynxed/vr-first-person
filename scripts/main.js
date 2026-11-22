/**
 * VR First Person for 3D Canvas.
 *
 * Hooks into 3D Canvas's three.js renderer, turns on WebXR, and renders the
 * scene from a camera rig that follows the selected token. The left thumbstick
 * moves the token one grid square at a time (same as the arrow keys), the
 * right thumbstick snap-turns.
 *
 * 3D Canvas has no public API for this, so everything that touches its
 * internals lives in the "3D Canvas access" section and is written defensively.
 */

const MODULE_ID = "vr-first-person";
const LOG = (...a) => console.log(`${MODULE_ID} |`, ...a);
const WARN = (...a) => console.warn(`${MODULE_ID} |`, ...a);

/* -------------------------------------------- */
/*  Settings                                     */
/* -------------------------------------------- */

function registerSettings() {
  const s = (key, data) => game.settings.register(MODULE_ID, key, { scope: "client", config: true, ...data });

  s("movementMode", {
    name: "Joystick movement direction",
    hint: "Head: pushing forward moves you the way you are looking. Map: pushing forward always moves up the map, exactly like the Up arrow key.",
    type: String,
    choices: { head: "Relative to where I'm looking", map: "Relative to the map (like arrow keys)" },
    default: "head"
  });
  s("repeatDelay", {
    name: "Step repeat delay (ms)",
    hint: "While the stick is held, take another step this often.",
    type: Number, range: { min: 150, max: 1000, step: 50 }, default: 350
  });
  s("snapTurn", {
    name: "Snap turn angle (right stick)",
    type: Number, choices: { 0: "Off", 30: "30°", 45: "45°", 90: "90°" }, default: 45
  });
  s("heightOffset", {
    name: "Height offset (meters)",
    hint: "Raise or lower your view. Useful when seated, or to match a small or tall character.",
    type: Number, range: { min: -1.5, max: 3, step: 0.05 }, default: 0
  });
  s("worldScale", {
    name: "World scale multiplier",
    hint: "If the world looks like a dollhouse or like you are an ant, adjust this. 1 = true scale from the grid size.",
    type: Number, range: { min: 0.1, max: 10, step: 0.05 }, default: 1
  });
  s("resolutionScale", {
    name: "VR resolution scale",
    hint: "Lower this if VR stutters or stops itself for being too slow. 1 = the headset's full resolution. Takes effect next time you enter VR.",
    type: Number, range: { min: 0.3, max: 1, step: 0.05 }, default: 0.7
  });
  s("hideOwnToken", {
    name: "Hide my own token in VR",
    hint: "Stops you seeing the inside of your own model.",
    type: Boolean, default: true
  });
  s("followSpeed", {
    name: "View follow speed",
    hint: "How quickly your view glides to your token's new square. Higher is snappier and can be easier on the stomach.",
    type: Number, range: { min: 2, max: 30, step: 1 }, default: 12
  });
}

const setting = (key) => game.settings.get(MODULE_ID, key);

/* -------------------------------------------- */
/*  3D Canvas access                             */
/* -------------------------------------------- */

function l3d() {
  return game.Levels3DPreview ?? globalThis.Levels3DPreview ?? null;
}

/** Find the WebGLRenderer, scene and camera 3D Canvas is using. */
function getEngine() {
  const g = l3d();
  if (!g) return null;
  const renderer = g.renderer ?? g._renderer;
  const scene = g.scene ?? g._scene;
  const camera = g.camera ?? g._camera;
  if (!renderer?.xr || !scene || !camera) return null;
  return { g, renderer, scene, camera };
}

/** Pull three.js classes from objects that already exist, so we never load a second copy of three. */
function getThreeClasses(camera) {
  const T = l3d()?.THREE;
  if (T?.Object3D && T?.Vector3) return { Object3D: T.Object3D, Vector3: T.Vector3, PerspectiveCamera: T.PerspectiveCamera };
  // PerspectiveCamera -> Camera -> Object3D
  const PerspectiveCamera = camera.constructor;
  const Object3D = Object.getPrototypeOf(Object.getPrototypeOf(PerspectiveCamera.prototype)).constructor;
  const Vector3 = camera.position.constructor;
  return { Object3D, Vector3, PerspectiveCamera };
}

/** 3D-Canvas object for a token, if we can find one. */
function getToken3D(tokenId) {
  const g = l3d();
  const t = g?.tokens?.[tokenId] ?? g?.tokens?.get?.(tokenId);
  return t?.mesh ?? t?.model ?? t?.object3d ?? null;
}

/** How many 3D units equal one pixel of the 2D map. */
function pixelsToUnits() {
  const factor = l3d()?.factor;
  return 1 / (typeof factor === "number" && factor > 0 ? factor : 1000);
}

/** 3D units per real-world meter, from the scene grid. */
function unitsPerMeter() {
  const grid = canvas.scene.grid ?? canvas.grid;
  const size = grid.size ?? canvas.grid.size;
  const distance = grid.distance ?? 5;
  const units = String(grid.units ?? "ft").toLowerCase();
  const toMeters = units.startsWith("m") ? 1 : units.startsWith("yd") ? 0.9144 : 0.3048;
  const gridMeters = distance * toMeters || 1.524;
  return (size * pixelsToUnits()) / gridMeters * setting("worldScale");
}

/** World position of the token's feet. */
function tokenAnchor(token, out) {
  const mesh = getToken3D(token.id);
  if (mesh?.getWorldPosition) {
    mesh.getWorldPosition(out);
    return out;
  }
  // Fallback: convert 2D map coordinates ourselves (x -> x, y -> z, elevation -> y).
  const p = pixelsToUnits();
  const c = token.center;
  const grid = canvas.scene.grid ?? canvas.grid;
  const elevPx = ((token.document.elevation ?? 0) / (grid.distance || 5)) * (grid.size ?? canvas.grid.size);
  return out.set(c.x * p, elevPx * p, c.y * p);
}

/* -------------------------------------------- */
/*  VR session                                   */
/* -------------------------------------------- */

const state = {
  session: null,
  engine: null,
  rig: null, recenter: null, vrCam: null,
  tokenId: null,
  origRender: null,
  allowRender: false,
  hostLoop: null,
  lastTime: 0,
  lastStep: 0,
  turnLatched: false,
  buttonsDown: new Set(),
  needsRecenter: true,
  tmp: null
};

function pickToken() {
  const charId = game.user.character?.id;
  return canvas.tokens.controlled[0]
    ?? (charId ? canvas.tokens.placeables.find(t => t.actor?.id === charId && t.isOwner) : null)
    ?? null;
}

/** Remember any loop 3D Canvas registers via setAnimationLoop so we can keep calling it. */
function watchAnimationLoop(renderer) {
  if (renderer.__vrfpWatched) return;
  const orig = renderer.setAnimationLoop.bind(renderer);
  renderer.setAnimationLoop = (cb) => {
    if (!state.session) state.hostLoop = cb;
    return orig(cb);
  };
  renderer.__vrfpOrigSetLoop = orig;
  renderer.__vrfpWatched = true;
}

/** Timestamped step log, so a freeze shows exactly which step it stopped at. */
let stepStart = 0;
const STEP = (msg, ...a) => LOG(`[+${Math.round(performance.now() - stepStart)}ms] ${msg}`, ...a);

function is3DVisible(renderer) {
  const el = renderer.domElement;
  return !!el?.isConnected && getComputedStyle(el).display !== "none" && el.clientWidth > 0;
}

async function enterVR() {
  if (state.session) return state.session.end();
  if (state.starting) return;              // ignore double-clicks while a session is starting
  stepStart = performance.now();

  // Only synchronous checks before requestSession, so the click still counts as a user gesture.
  const engine = getEngine();
  if (!engine) return ui.notifications.warn("VR: 3D Canvas isn't running on this scene. Turn on 3D mode first.");
  if (!is3DVisible(engine.renderer)) return ui.notifications.warn("VR: Switch this scene to 3D mode first.");
  if (!navigator.xr) return ui.notifications.warn("VR: This browser has no WebXR. Use Edge or Chrome over HTTPS.");
  const token = pickToken();
  if (!token) return ui.notifications.warn("VR: Select the token you want to see through first.");

  state.starting = true;
  updateButton();
  let session;
  try {
    STEP("requesting VR session");
    session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor"] });
    STEP("VR session granted");
  } catch (err) {
    WARN(err);
    state.starting = false;
    updateButton();
    return ui.notifications.error(`VR: Couldn't start a VR session (${err.message}). Is Virtual Desktop streaming?`);
  }

  try {
    await setupVR(session, engine, token);
  } catch (err) {
    WARN("VR setup failed", err);
    ui.notifications.error(`VR: Setup failed (${err.message}). Details are in the F12 console.`);
    session.end().catch(() => {});
    state.starting = true;   // make sure exitVR cleans up even if state.engine was never set
    exitVR();
  }
}

async function setupVR(session, engine, token) {
  const { renderer, scene, camera } = engine;
  const { Object3D, Vector3, PerspectiveCamera } = getThreeClasses(camera);

  // Camera rig: rig follows the token + snap turn + scale, recenter shifts your real-world spot onto it.
  const rig = new Object3D();
  rig.name = "vrfp-rig";
  const recenter = new Object3D();
  const vrCam = new PerspectiveCamera(70, 1, 0.05, 2000);
  rig.add(recenter);
  recenter.add(vrCam);
  scene.add(rig);

  Object.assign(state, {
    session, engine, rig, recenter, vrCam,
    tokenId: token.id,
    lastTime: performance.now(), lastStep: 0,
    turnLatched: false, needsRecenter: true,
    buttonsDown: new Set(),
    tmp: { anchor: new Vector3(), dir: new Vector3() }
  });

  rig.scale.setScalar(unitsPerMeter());
  tokenAnchor(token, rig.position);
  // Start facing the way the 3D Canvas camera was looking.
  camera.getWorldDirection(state.tmp.dir);
  rig.rotation.y = Math.atan2(-state.tmp.dir.x, -state.tmp.dir.z);

  // Block 3D Canvas's own render calls while we're in VR; we render once per XR frame ourselves.
  state.origRender = renderer.render;
  renderer.render = function (...args) {
    if (state.session && !state.allowRender) return;
    return state.origRender.apply(this, args);
  };

  watchAnimationLoop(renderer);
  STEP("hooked 3D Canvas render loop", { hostLoopCaptured: !!state.hostLoop });
  session.addEventListener("end", exitVR);
  state.onContextLost = () => {
    WARN("WebGL context lost while entering/using VR");
    ui.notifications.error("VR: The 3D view's graphics context was lost. Leaving VR; reload the page if the 3D view stays black.");
    state.session?.end().catch(() => {});
  };
  renderer.domElement.addEventListener("webglcontextlost", state.onContextLost);

  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  renderer.xr.setFramebufferScaleFactor?.(setting("resolutionScale"));
  try {
    STEP("handing the 3D renderer to the headset (setSession)");
    await renderer.xr.setSession(session);
    STEP("setSession done");
  } catch (err) {
    WARN(err);
    ui.notifications.error(`VR: The headset session failed to start (${err.message}).`);
    session.end().catch(() => {});
    return exitVR();
  }
  Object.assign(state, { frameCount: 0, slowFrames: 0 });
  renderer.__vrfpOrigSetLoop(onXRFrame);
  state.starting = false;
  updateButton();
  STEP("entered VR on token", token.name);
}

function exitVR() {
  if (!state.engine && !state.starting) return;  // already cleaned up
  const { engine, rig } = state;
  if (engine) {
    const { renderer, scene } = engine;
    if (state.origRender) renderer.render = state.origRender;
    renderer.__vrfpOrigSetLoop?.(state.hostLoop ?? null);
    renderer.xr.enabled = false;
    if (rig) scene.remove(rig);
    if (state.onContextLost) renderer.domElement.removeEventListener("webglcontextlost", state.onContextLost);
    // three.js restores the canvas size and pixel ratio itself when the session ends.
  }
  Object.assign(state, {
    session: null, engine: null, rig: null, recenter: null, vrCam: null,
    origRender: null, starting: false, onContextLost: null
  });
  updateButton();
  LOG("Left VR");
}

/**
 * Watchdog: a frame this slow means the page is effectively frozen for the player.
 * Bail out of VR instead of letting Edge show "Page not responding".
 */
function watchdog(ms, parts) {
  state.frameCount++;
  if (state.frameCount <= 3) STEP(`XR frame ${state.frameCount} took ${ms.toFixed(0)}ms`, parts);
  if (ms > 250) {
    state.slowFrames++;
    WARN(`slow XR frame: ${ms.toFixed(0)}ms`, parts);
  } else state.slowFrames = 0;
  if (ms > 2000 || state.slowFrames >= 5) {
    ui.notifications.error(`VR: Rendering is too slow for VR (${ms.toFixed(0)}ms per frame), so VR was stopped. Try a lower "VR resolution scale" or lower 3D Canvas quality.`);
    state.session?.end().catch(() => {});
    return true;
  }
  return false;
}

function onXRFrame(time, frame) {
  const t0 = performance.now();
  try {
    const parts = renderXRFrame(time, frame);
    if (parts) watchdog(performance.now() - t0, parts);
  } catch (err) {
    // An exception every frame would spam forever; end the session instead.
    WARN("VR frame failed, leaving VR", err);
    ui.notifications.error(`VR: ${err.message}. Leaving VR (details in the F12 console).`);
    state.session?.end().catch(() => {});
  }
}

function renderXRFrame(time, frame) {
  const { engine, rig, recenter, vrCam, tmp } = state;
  if (!engine) return null;
  const { renderer, scene } = engine;
  const parts = {};

  // Let 3D Canvas run its own per-frame updates (animations etc.), if it uses setAnimationLoop.
  let t = performance.now();
  try { state.hostLoop?.(time, frame); } catch (err) { WARN("3D Canvas frame error", err); }
  parts.host = Math.round(performance.now() - t);

  const now = performance.now();
  const dt = Math.min((now - state.lastTime) / 1000, 0.1);
  state.lastTime = now;

  const token = canvas.tokens.get(state.tokenId);
  if (!token) {
    state.session?.end().catch(() => {});
    return null;
  }

  // Glide the rig to the token's feet.
  rig.scale.setScalar(unitsPerMeter());
  tokenAnchor(token, tmp.anchor);
  tmp.anchor.y += setting("heightOffset") * rig.scale.x;
  rig.position.lerp(tmp.anchor, 1 - Math.exp(-dt * setting("followSpeed")));

  if (state.needsRecenter && frame) {
    // vrCam.position holds last frame's head pose (in recenter space); wait for a real pose.
    if (vrCam.position.lengthSq() > 0) {
      recenter.position.set(-vrCam.position.x, 0, -vrCam.position.z);
      state.needsRecenter = false;
    }
  }

  handleInput(token, now);

  // Hide our own model just for this render.
  const mesh = setting("hideOwnToken") ? getToken3D(token.id) : null;
  const wasVisible = mesh?.visible;
  if (mesh) mesh.visible = false;
  t = performance.now();
  state.allowRender = true;
  try { state.origRender.call(renderer, scene, vrCam); }
  finally {
    state.allowRender = false;
    if (mesh) mesh.visible = wasVisible;
  }
  parts.render = Math.round(performance.now() - t);
  return parts;
}

/* -------------------------------------------- */
/*  Controllers                                  */
/* -------------------------------------------- */

function readControllers() {
  const out = { left: null, right: null };
  for (const src of state.session?.inputSources ?? []) {
    if (src.gamepad && (src.handedness === "left" || src.handedness === "right")) out[src.handedness] = src.gamepad;
  }
  return out;
}

/** Quest controllers (xr-standard): thumbstick = axes[2], axes[3]; A/X = buttons[4], B/Y = buttons[5]. */
function stick(gp) {
  if (!gp) return { x: 0, y: 0 };
  const x = gp.axes[2] ?? gp.axes[0] ?? 0;
  const y = gp.axes[3] ?? gp.axes[1] ?? 0;
  return { x, y };
}

function pressedOnce(gp, index, key) {
  const down = !!gp?.buttons[index]?.pressed;
  const was = state.buttonsDown.has(key);
  if (down) state.buttonsDown.add(key); else state.buttonsDown.delete(key);
  return down && !was;
}

function handleInput(token, now) {
  const { left, right } = readControllers();

  // A or X: recenter. B or Y: leave VR.
  if (pressedOnce(right, 4, "A") || pressedOnce(left, 4, "X")) state.needsRecenter = true;
  if (pressedOnce(right, 5, "B") || pressedOnce(left, 5, "Y")) return state.session.end();

  // Right stick: snap turn.
  const turn = Number(setting("snapTurn"));
  const r = stick(right);
  if (turn && Math.abs(r.x) > 0.7 && !state.turnLatched) {
    state.turnLatched = true;
    state.rig.rotation.y -= Math.sign(r.x) * turn * Math.PI / 180;
  } else if (Math.abs(r.x) < 0.3) state.turnLatched = false;

  // Left stick: step like arrow keys.
  const l = stick(left);
  const mag = Math.hypot(l.x, l.y);
  if (mag < 0.6) { state.lastStep = 0; return; }
  if (state.lastStep && now - state.lastStep < setting("repeatDelay")) return;
  state.lastStep = now;

  const step = setting("movementMode") === "map" ? mapStep(l) : headStep(l);
  if (step.dx || step.dy) moveToken(token, step);
}

/** Exactly the arrow keys: stick up = map up. */
function mapStep({ x, y }) {
  const dx = Math.abs(x) > 0.5 ? Math.sign(x) : 0;
  const dy = Math.abs(y) > 0.5 ? Math.sign(y) : 0;
  return { dx, dy };
}

/** Stick direction relative to where the head is facing, snapped to 8 map directions. */
function headStep({ x, y }) {
  const dir = state.tmp.dir;
  state.vrCam.getWorldDirection(dir);
  const fLen = Math.hypot(dir.x, dir.z) || 1;
  const fx = dir.x / fLen, fz = dir.z / fLen;    // forward on the ground
  const rx = -fz, rz = fx;                        // right on the ground
  const mx = rx * x + fx * -y;                     // stick up (y = -1) = forward
  const mz = rz * x + fz * -y;
  // 3D Canvas maps 2D x -> 3D x and 2D y -> 3D z.
  const angle = Math.atan2(mz, mx);
  const oct = Math.round(angle / (Math.PI / 4));
  return { dx: Math.round(Math.cos(oct * Math.PI / 4)), dy: Math.round(Math.sin(oct * Math.PI / 4)) };
}

async function moveToken(token, { dx, dy }) {
  if (!token.isOwner) return;
  if (!token.controlled) token.control({ releaseOthers: true });
  try {
    // Same call Foundry's own arrow-key handler uses: grid-aware, respects walls.
    await canvas.tokens.moveMany({ dx, dy, ids: [token.id] });
  } catch (err) {
    WARN("Move failed", err);
  }
}

/* -------------------------------------------- */
/*  UI + hooks                                   */
/* -------------------------------------------- */

function updateButton() {
  let btn = document.getElementById("vrfp-enter");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "vrfp-enter";
    btn.type = "button";
    btn.addEventListener("click", () => enterVR());
    document.body.appendChild(btn);
  }
  const inVR = !!state.session && !state.starting;
  const label = state.starting ? "Starting VR…" : inVR ? "Exit VR" : "Enter VR";
  btn.innerHTML = `<i class="fas fa-vr-cardboard"></i> ${label}`;
  btn.disabled = !!state.starting;
  btn.classList.toggle("vrfp-active", inVR);
  // Only show it to players who actually have a headset connected.
  btn.style.display = (getEngine() && headsetAvailable) || state.session ? "" : "none";
}

let headsetAvailable = false;
async function checkHeadset() {
  try {
    headsetAvailable = !!(await navigator.xr?.isSessionSupported("immersive-vr"));
  } catch { headsetAvailable = false; }
  updateButton();
}

function diagnose() {
  const g = l3d();
  const engine = getEngine();
  const token = pickToken();
  const report = {
    "3D Canvas global found": !!g,
    "3D Canvas keys": g ? Object.keys(g).slice(0, 60) : [],
    "renderer / scene / camera found": !!engine,
    "factor (px per unit)": g?.factor,
    "tokens map found": !!g?.tokens,
    "selected token": token?.name ?? null,
    "token 3D object found": token ? !!getToken3D(token.id) : null,
    "units per meter": canvas?.ready ? unitsPerMeter() : null,
    "WebXR available": !!navigator.xr,
    "headset detected": headsetAvailable,
    "3D view visible": engine ? is3DVisible(engine.renderer) : false,
    "secure context (HTTPS)": window.isSecureContext,
    "hooked into setAnimationLoop": !!state.hostLoop
  };
  console.table(report);
  return report;
}

Hooks.once("init", () => {
  registerSettings();
  game.modules.get(MODULE_ID).api = { enterVR, exitVR: () => state.session?.end(), diagnose };
});

Hooks.once("ready", () => {
  // 3D Canvas sets itself up asynchronously; poll briefly for its renderer.
  const tryWatch = () => {
    const e = getEngine();
    if (e) watchAnimationLoop(e.renderer);
    updateButton();
  };
  tryWatch();
  checkHeadset();
  navigator.xr?.addEventListener?.("devicechange", checkHeadset);
  const iv = setInterval(tryWatch, 2000);
  setTimeout(() => clearInterval(iv), 60000);
});

Hooks.on("canvasReady", () => setTimeout(() => {
  const e = getEngine();
  if (e) watchAnimationLoop(e.renderer);
  updateButton();
}, 1500));
Hooks.on("canvasTearDown", () => state.session?.end());
