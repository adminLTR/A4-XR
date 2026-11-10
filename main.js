// MAC0623 — A4 Mobile AR Docking
//
// Hit-test: three.js webxr_ar_hittest (viewer ray + reticle.matrix.decompose).
// Task: place a workspace on a real table, then dock one 3-color cube into
// a translucent ghost (x, z, yaw). Opposite faces share a color.
//   1. touch  — one-finger drag on the plane, two-finger twist
//   2. carry  — hold a button and move the phone; ↺ ↻ for yaw
//
// Timing starts at the first move of the cube and ends when the user taps
// Finalizar intento.

import * as THREE from "three";
import { ARButton } from "three/addons/webxr/ARButton.js";
import { XRPlanes } from "three/addons/webxr/XRPlanes.js";

const SIZE = 0.20;
const POS_TOLERANCE_M = 0.02;
const YAW_TOLERANCE_DEG = 10;
const OBJECT_DISTANCE_MIN = 0.28;
const OBJECT_DISTANCE_MAX = 0.40;
const CARRY_ROT_STEP = THREE.MathUtils.degToRad(8);

// BoxGeometry materials: +X, -X, +Y, -Y, +Z, -Z. Opposite faces share a color.
const FACE_COLOR_X = 0x3d8bfd;
const FACE_COLOR_Y = 0xf1c40f;
const FACE_COLOR_Z = 0xe74c3c;
const FACE_COLORS = [
  FACE_COLOR_X, FACE_COLOR_X,
  FACE_COLOR_Y, FACE_COLOR_Y,
  FACE_COLOR_Z, FACE_COLOR_Z,
];

const CSV_HEADER = [
  "participant_id",
  "technique",
  "trial",
  "completion_time_s",
  "pos_error_cm",
  "yaw_error_deg",
  "wrong_selections",
  "touch_count",
  "tracking_lost",
];

const participantIdInput = document.getElementById("participantId");
const techniqueSelect = document.getElementById("techniqueSelect");
const trialCountEl = document.getElementById("trialCount");
const finishBtn = document.getElementById("finishBtn");
const replaceBtn = document.getElementById("replaceBtn");
const exitARBtn = document.getElementById("exitARBtn");
const arGate = document.getElementById("arGate");
const arGateTitle = document.getElementById("arGateTitle");
const arGateBody = document.getElementById("arGateBody");
const enterARBtn = document.getElementById("enterARBtn");
const errorCard = document.getElementById("errorCard");
const placeBtn = document.getElementById("placeBtn");
const aimEl = document.getElementById("aim");
const cardTitle = document.getElementById("cardTitle");
const posErrorEl = document.getElementById("posError");
const yawErrorEl = document.getElementById("yawError");
const cardStatus = document.getElementById("cardStatus");
const carryBar = document.getElementById("carryBar");
const carryBtn = document.getElementById("carryBtn");
const rotLeftBtn = document.getElementById("rotLeftBtn");
const rotRightBtn = document.getElementById("rotRightBtn");
const overlay = document.getElementById("overlay");

const rows = [];
const pointers = new Map();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _local = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _workPlane = new THREE.Plane();
const _one = new THREE.Vector3(1, 1, 1);
const _reticleQuat = new THREE.Quaternion();

let scene, camera, renderer;
let reticle, workspace, ghost, desktopHelpers, xrPlanes;
let arSupported = false;
let objects = [];
let selected = null;

let hitTestSource = null;
let hitTestSourceRequested = false;
let hadHit = false;

let technique = "touch";
let workspacePlaced = false;
let trialIndexByTechnique = { touch: 0, carry: 0 };
let trialActive = false;
let trialStartTime = 0;
let correctSelectTime = 0;
let wrongSelections = 0;
let touchCount = 0;
let trackingLost = 0;

let dragging = false;
let rotating = false;
let lastTwist = 0;
let carrying = false;
let rotHoldTimer = 0;
let rotHoldDir = 0;
let lastPointerAt = 0;
let hadPose = true;

function participantId() {
  return (participantIdInput.value.trim() || "UNKNOWN").replace(/,/g, "");
}

function matchingObject() {
  return objects[0] || null;
}

function shortestYawDeg(a, b) {
  let d = THREE.MathUtils.radToDeg(a - b);
  d = ((d + 180) % 360 + 360) % 360 - 180;
  return Math.abs(d);
}

function measureErrors() {
  const match = matchingObject();
  if (!workspacePlaced || !match) return { posCm: null, yawDeg: null, docked: false };
  workspace.worldToLocal(_local.copy(match.position));
  const gx = ghost.position.x;
  const gz = ghost.position.z;
  const posCm = Math.hypot(_local.x - gx, _local.z - gz) * 100;
  const yawDeg = shortestYawDeg(match.rotation.y, ghost.rotation.y);
  return {
    posCm,
    yawDeg,
    docked: posCm <= POS_TOLERANCE_M * 100 && yawDeg <= YAW_TOLERANCE_DEG,
  };
}

function makeMaterial(color, ghosted) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.42,
    metalness: 0.08,
    transparent: ghosted,
    opacity: ghosted ? 0.45 : 1,
    depthWrite: !ghosted,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0,
  });
}

function eachMaterial(mesh, fn) {
  if (!mesh) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  mats.forEach(fn);
}

function makeShapeMesh(ghosted) {
  const geometry = new THREE.BoxGeometry(SIZE, SIZE, SIZE);
  const mesh = new THREE.Mesh(
    geometry,
    FACE_COLORS.map((color) => makeMaterial(color, ghosted))
  );
  mesh.position.y = SIZE / 2;
  mesh.castShadow = false;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({
      color: 0x111111,
      transparent: ghosted,
      opacity: ghosted ? 0.35 : 0.9,
    })
  );
  edges.userData.ignorePick = true;
  mesh.add(edges);
  return mesh;
}

function makeYawMark(ghosted) {
  const mark = new THREE.Mesh(
    new THREE.ConeGeometry(SIZE * 0.07, SIZE * 0.16, 3),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: ghosted,
      opacity: ghosted ? 0.7 : 1,
      depthWrite: !ghosted,
    })
  );
  mark.rotation.x = -Math.PI / 2;
  mark.position.set(0, SIZE + 0.001, SIZE * 0.22);
  mark.userData.ignorePick = true;
  return mark;
}

function makeHighlightRing() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(SIZE * 0.62, SIZE * 0.78, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.002;
  ring.visible = false;
  ring.userData.ignorePick = true;
  return ring;
}

function createPiece(ghosted) {
  const group = new THREE.Group();
  group.userData.type = "cube";
  group.userData.ghosted = ghosted;
  const mesh = makeShapeMesh(ghosted);
  mesh.name = "body";
  group.add(mesh);
  group.add(makeYawMark(ghosted));
  if (!ghosted) {
    group.add(makeHighlightRing());
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(SIZE * 0.85, 10, 8),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hit.position.y = SIZE / 2;
    hit.name = "hit";
    group.add(hit);
  }
  return group;
}

function buildWorkspace() {
  workspace = new THREE.Group();
  workspace.name = "workspace";
  workspace.visible = false;

  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(0.7, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  disk.rotation.x = -Math.PI / 2;
  disk.position.y = 0.001;
  disk.userData.ignorePick = true;
  workspace.add(disk);

  const piece = createPiece(false);
  piece.name = "cube";
  workspace.add(piece);
  objects = [piece];

  ghost = createPiece(true);
  ghost.name = "ghost";
  workspace.add(ghost);
  scene.add(workspace);
}

function buildReticle() {
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.18, 0.26, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x7cff9a,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  reticle.userData.estimated = true;
  scene.add(reticle);

  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(0.02, 16).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x7cff9a, depthTest: false })
  );
  reticle.add(inner);
}

function getViewCamera() {
  if (renderer.xr.isPresenting) {
    if (typeof renderer.xr.updateCamera === "function") {
      renderer.xr.updateCamera(camera);
    }
    const xrCam = renderer.xr.getCamera();
    xrCam.updateMatrixWorld(true);
    return xrCam;
  }
  camera.updateMatrixWorld(true);
  return camera;
}

function updateWorkPlane() {
  _normal.set(0, 1, 0).applyQuaternion(workspace.quaternion);
  _workPlane.setFromNormalAndCoplanarPoint(_normal, workspace.position);
}

function setPieceOnPlane(piece, worldPoint) {
  workspace.worldToLocal(_local.copy(worldPoint));
  piece.position.set(_local.x, 0, _local.z);
}

function layoutTrial() {
  ghost.position.set(0, 0, 0);
  ghost.rotation.set(0, Math.random() * Math.PI * 2, 0);

  getViewCamera().getWorldPosition(_camPos);
  workspace.worldToLocal(_local.copy(_camPos));
  _local.y = 0;
  if (_local.lengthSq() < 1e-6) _local.set(0, 0, 1);
  _local.normalize();

  const facing = Math.atan2(_local.x, _local.z);
  const dist = THREE.MathUtils.lerp(OBJECT_DISTANCE_MIN, OBJECT_DISTANCE_MAX, Math.random());
  const piece = objects[0];
  piece.position.set(Math.sin(facing) * dist, 0, Math.cos(facing) * dist);
  piece.rotation.set(0, Math.random() * Math.PI * 2, 0);

  applyDockedLook(false);
}

function placeWorkspaceFromReticle() {
  if (!reticle.visible) return;
  reticle.matrix.decompose(workspace.position, workspace.quaternion, workspace.scale);
  if (reticle.userData.estimated) {
    workspace.quaternion.identity();
  }
  workspace.scale.set(1, 1, 1);
  workspace.visible = true;
  workspacePlaced = true;
  reticle.visible = false;
  if (xrPlanes) xrPlanes.visible = false;
  workspace.updateMatrixWorld(true);
  updateWorkPlane();
  beginTrial();
}

function placeWorkspaceDesktop(point) {
  workspace.position.copy(point);
  workspace.quaternion.identity();
  workspace.scale.set(1, 1, 1);
  workspace.visible = true;
  workspacePlaced = true;
  reticle.visible = false;
  if (xrPlanes) xrPlanes.visible = false;
  workspace.updateMatrixWorld(true);
  updateWorkPlane();
  beginTrial();
}

function beginTrial() {
  layoutTrial();
  trialActive = true;
  trialStartTime = performance.now();
  correctSelectTime = 0;
  wrongSelections = 0;
  touchCount = 0;
  trackingLost = 0;
  carrying = false;
  carryBtn.classList.remove("held");
  if (objects[0]) selectPiece(objects[0], false);
  updateHud();
}

function relocate() {
  workspace.visible = false;
  workspacePlaced = false;
  trialActive = false;
  if (xrPlanes) xrPlanes.visible = true;
  if (reticle) {
    reticle.visible = false;
    reticle.userData.estimated = true;
  }
  clearSelection();
  carrying = false;
  dragging = false;
  rotating = false;
  pointers.clear();
  updateHud();
}

function highlightPiece(piece, on) {
  const body = piece.getObjectByName("body");
  const ring = piece.children.find((c) => c.geometry && c.geometry.type === "RingGeometry");
  eachMaterial(body, (mat) => {
    mat.emissive.setHex(on ? 0xffffff : 0x000000);
    mat.emissiveIntensity = on ? 0.16 : 0;
  });
  if (ring) ring.visible = on;
}

function clearSelection() {
  if (selected) highlightPiece(selected, false);
  selected = null;
}

function markTrialStarted() {
  if (trialActive && !correctSelectTime) correctSelectTime = performance.now();
}

function selectPiece(piece, startTimer = true) {
  if (selected !== piece) {
    if (selected) highlightPiece(selected, false);
    selected = piece;
    highlightPiece(piece, true);
  }
  if (startTimer) markTrialStarted();
}

function pointerToNDC(event) {
  _ndc.set(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1
  );
  return _ndc;
}

function activeCamera() {
  return renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
}

function pickPiece(event) {
  _raycaster.setFromCamera(pointerToNDC(event), getViewCamera());
  const hits = _raycaster.intersectObjects(objects, true);
  for (const hit of hits) {
    let node = hit.object;
    while (node && !objects.includes(node)) node = node.parent;
    if (node) return node;
  }
  return null;
}

function intersectWorkPlane(event) {
  updateWorkPlane();
  _raycaster.setFromCamera(pointerToNDC(event), getViewCamera());
  return _raycaster.ray.intersectPlane(_workPlane, _hit) ? _hit : null;
}

function intersectWorkPlaneCenter() {
  updateWorkPlane();
  _raycaster.setFromCamera(new THREE.Vector2(0, 0), getViewCamera());
  return _raycaster.ray.intersectPlane(_workPlane, _hit) ? _hit : null;
}

function twistAngle() {
  const pts = [...pointers.values()];
  if (pts.length < 2) return 0;
  return Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
}

function isHudEvent(event) {
  return Boolean(event.target.closest("#hud, #carryBar, #arGate, #ARButton, #errorCard, button, input, select, label, a"));
}

function hasRealHit() {
  return Boolean(reticle && reticle.visible && !reticle.userData.estimated);
}

function hasPlaceableReticle() {
  return Boolean(reticle && reticle.visible);
}

function tryPlaceWorkspace() {
  if (workspacePlaced || !isPresenting()) return;
  if (!hasPlaceableReticle()) {
    cardStatus.textContent = "Espera un momento con la cámara activa hasta que aparezca el anillo.";
    return;
  }
  placeWorkspaceFromReticle();
}

function onPointerDown(event) {
  if (isHudEvent(event)) return;
  lastPointerAt = performance.now();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (trialActive) touchCount += 1;

  if (!workspacePlaced) {
    if (isPresenting()) {
      tryPlaceWorkspace();
    } else if (!isPhone() && desktopHelpers) {
      _raycaster.setFromCamera(pointerToNDC(event), camera);
      const hits = _raycaster.intersectObject(desktopHelpers, true);
      if (hits.length) placeWorkspaceDesktop(hits[0].point);
    }
    return;
  }

  if (pointers.size === 1) {
    const piece = pickPiece(event);
    if (piece) {
      selectPiece(piece);
      if (technique === "touch") dragging = true;
    }
  } else if (pointers.size >= 2 && technique === "touch" && selected) {
    dragging = false;
    rotating = true;
    lastTwist = twistAngle();
  }
}

function onPointerMove(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (!workspacePlaced || !selected) return;

  if (rotating && pointers.size >= 2 && technique === "touch") {
    const angle = twistAngle();
    selected.rotation.y += angle - lastTwist;
    lastTwist = angle;
    markTrialStarted();
    return;
  }

  if (dragging && technique === "touch") {
    const point = intersectWorkPlane(event);
    if (point) {
      setPieceOnPlane(selected, point);
      markTrialStarted();
    }
  }
}

function onPointerUp(event) {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) rotating = false;
  if (pointers.size === 0) dragging = false;
}

function applyCarry() {
  if (!carrying || technique !== "carry" || !selected || !workspacePlaced) return;
  const point = intersectWorkPlaneCenter();
  if (point) {
    setPieceOnPlane(selected, point);
    markTrialStarted();
  }
}

function nudgeYaw(dir) {
  if (!selected) return;
  selected.rotation.y += dir * CARRY_ROT_STEP;
  markTrialStarted();
}

function startRotHold(dir) {
  rotHoldDir = dir;
  nudgeYaw(dir);
  window.clearInterval(rotHoldTimer);
  rotHoldTimer = window.setInterval(() => nudgeYaw(rotHoldDir), 90);
}

function stopRotHold() {
  window.clearInterval(rotHoldTimer);
  rotHoldTimer = 0;
  rotHoldDir = 0;
}

function applyDockedLook(on) {
  if (!ghost) return;
  eachMaterial(ghost.getObjectByName("body"), (mat) => {
    mat.emissive.setHex(on ? 0x33ff66 : 0x000000);
    mat.emissiveIntensity = on ? 0.28 : 0;
  });
}

function isPresenting() {
  return Boolean(renderer && renderer.xr && renderer.xr.isPresenting);
}

function isPhone() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isIOS() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function updateHud() {
  const presenting = isPresenting();
  arGate.hidden = presenting;
  errorCard.hidden = !presenting;
  overlay.classList.toggle("placed", workspacePlaced);
  overlay.classList.toggle("presenting", presenting);

  const errors = measureErrors();

  errorCard.classList.toggle("in-tolerance", Boolean(errors.docked));
  errorCard.classList.toggle("wrong-selected", false);
  applyDockedLook(Boolean(errors.docked));

  if (!presenting) {
    trialCountEl.textContent = `Intento ${trialIndexByTechnique[technique] + 1}`;
    carryBar.hidden = true;
    if (aimEl) aimEl.hidden = true;
    if (placeBtn) placeBtn.hidden = true;
    return;
  }

  const tracked = hasRealHit();
  const placeable = hasPlaceableReticle();
  const estimated = placeable && reticle && reticle.userData.estimated;
  if (aimEl) {
    aimEl.hidden = workspacePlaced || !placeable;
    aimEl.classList.toggle("tracked", tracked);
  }
  if (placeBtn) {
    placeBtn.hidden = workspacePlaced;
    placeBtn.disabled = !workspacePlaced && !placeable;
  }

  if (!workspacePlaced) {
    cardTitle.textContent = tracked
      ? "Superficie detectada"
      : estimated
        ? "Lista para colocar (estimado)"
        : hitTestSource ? "Buscando superficie" : "Iniciando detección";
    posErrorEl.textContent = "—";
    yawErrorEl.textContent = "—";
    cardStatus.textContent = placeable
      ? (estimated
        ? "Anillo naranja: apunta al centro de la mesa y pulsa Colocar. El cubo se queda fijo ahí."
        : "Toca la pantalla o pulsa Colocar cubo aquí")
      : "Mantén la cámara apuntando a la mesa. En unos segundos debe aparecer un anillo.";
  } else {
    cardTitle.textContent = "Encaja el cubo en el fantasma";
    posErrorEl.textContent = errors.posCm == null ? "—" : `${errors.posCm.toFixed(1)} cm`;
    yawErrorEl.textContent = errors.yawDeg == null ? "—" : `${errors.yawDeg.toFixed(1)}°`;
    if (errors.docked) {
      cardStatus.textContent = "Encajado — pulsa Finalizar intento";
    } else if (selected) {
      cardStatus.textContent = technique === "carry"
        ? "Mantén Llevar y mueve el teléfono; ↺ ↻ rotan. Alinea colores y la flecha blanca."
        : "Arrastra con un dedo; gira con dos. Alinea colores y la flecha blanca.";
    } else {
      cardStatus.textContent = "Toca el cubo para seleccionarlo";
    }
  }

  trialCountEl.textContent = `Intento ${trialIndexByTechnique[technique] + 1}`;
  carryBar.hidden = technique !== "carry";
}

function finishTrial() {
  if (!workspacePlaced || !trialActive) return;
  const errors = measureErrors();
  const now = performance.now();
  const start = correctSelectTime || trialStartTime;
  const row = {
    participant_id: participantId(),
    technique,
    trial: trialIndexByTechnique[technique] + 1,
    completion_time_s: ((now - start) / 1000).toFixed(3),
    pos_error_cm: errors.posCm == null ? "" : errors.posCm.toFixed(2),
    yaw_error_deg: errors.yawDeg == null ? "" : errors.yawDeg.toFixed(2),
    wrong_selections: wrongSelections,
    touch_count: touchCount,
    tracking_lost: trackingLost,
  };
  rows.push(row);
  trialIndexByTechnique[technique] += 1;
  trialActive = false;
  cardStatus.textContent = `Intento ${row.trial} guardado — colocando el siguiente`;
  window.setTimeout(() => {
    if (workspacePlaced) beginTrial();
  }, 350);
}

function buildCsv() {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(CSV_HEADER.map((key) => row[key]).join(","));
  }
  return lines.join("\n");
}

function downloadCsv() {
  const blob = new Blob([buildCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `A4_${participantId()}_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function setTechnique(next) {
  technique = next;
  carrying = false;
  dragging = false;
  rotating = false;
  carryBtn.classList.remove("held");
  if (workspacePlaced) beginTrial();
  else updateHud();
}

function sessionInit() {
  return {
    requiredFeatures: ["hit-test"],
    optionalFeatures: ["dom-overlay", "plane-detection"],
    domOverlay: { root: overlay },
  };
}

function setGateMessage(title, body) {
  arGateTitle.textContent = title;
  arGateBody.innerHTML = body;
}

async function diagnoseAR() {
  const secure = window.isSecureContext;
  const hasXr = "xr" in navigator;
  let immersive = false;

  if (!secure) {
    setGateMessage(
      "Esta página no está en HTTPS",
      "WebXR solo funciona en HTTPS. Abre la URL de GitHub Pages (https://…)."
    );
  } else if (isIOS()) {
    setGateMessage(
      "iPhone no soporta este WebXR AR",
      "La tarea pide un <b>Android con Chrome</b> y ARCore."
    );
  } else if (!hasXr) {
    setGateMessage(
      "Este navegador no tiene WebXR",
      "Abre la página con <b>Chrome</b> e instala <b>Google Play Services for AR</b>."
    );
  } else {
    immersive = await navigator.xr.isSessionSupported("immersive-ar").catch(() => false);
    if (immersive) {
      arSupported = true;
      setGateMessage(
        "Listo para usar la cámara",
        "Pulsa <b>Entrar en AR</b> o el botón naranja <b>START AR</b> abajo. Recorre la mesa despacio hasta ver un parche verde y el anillo; entonces toca para colocar."
      );
    } else {
      setGateMessage(
        "Este dispositivo no activa immersive-ar",
        "Usa <b>Chrome para Android</b> e instala <b>Google Play Services for AR</b>."
      );
    }
  }

  enterARBtn.disabled = !arSupported;
  return immersive;
}

async function startAR() {
  if (isPresenting()) return;
  if (!arSupported) {
    await diagnoseAR();
    return;
  }
  try {
    renderer.xr.setReferenceSpaceType("local-floor");
    const session = await navigator.xr.requestSession("immersive-ar", sessionInit());
    await renderer.xr.setSession(session);
  } catch (firstErr) {
    try {
      renderer.xr.setReferenceSpaceType("local");
      const session = await navigator.xr.requestSession("immersive-ar", sessionInit());
      await renderer.xr.setSession(session);
    } catch (err) {
      setGateMessage(
        "No se pudo iniciar AR",
        `El navegador rechazó la sesión: <b>${err.message}</b>.`
      );
      console.warn("AR session failed", firstErr, err);
    }
  }
}

function endAR() {
  const session = renderer.xr.getSession();
  if (session) session.end();
}

function onSessionStart() {
  if (desktopHelpers) desktopHelpers.visible = false;
  scene.background = null;
  exitARBtn.hidden = false;
  overlay.style.display = "";
  hitTestSource = null;
  hitTestSourceRequested = false;
  relocate();
}

function pickFromRay(origin, direction) {
  _raycaster.set(origin, direction);
  const hits = _raycaster.intersectObjects(objects, true);
  for (const hit of hits) {
    let node = hit.object;
    while (node && !objects.includes(node)) node = node.parent;
    if (node) return node;
  }
  return null;
}

function onControllerSelect(event) {
  if (performance.now() - lastPointerAt < 400) return;
  if (!workspacePlaced) {
    tryPlaceWorkspace();
    return;
  }
  const controller = event.target;
  controller.getWorldPosition(_camPos);
  controller.getWorldDirection(_forward);
  _forward.negate();
  const piece = pickFromRay(_camPos, _forward);
  if (piece) selectPiece(piece);
}

function setupControllers() {
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    controller.addEventListener("select", onControllerSelect);
    scene.add(controller);
  }
}

function restoreOverlay() {
  overlay.style.display = "";
}

function onSessionEnd() {
  if (desktopHelpers) desktopHelpers.visible = !isPhone();
  scene.background = isPhone() ? null : new THREE.Color(0x9eb4c4);
  exitARBtn.hidden = true;
  restoreOverlay();
  window.setTimeout(restoreOverlay, 0);
  camera.position.set(0.05, 0.85, 0.95);
  camera.lookAt(0, 0, 0);
  updateHud();
}

function styleDetectedPlanes() {
  if (!xrPlanes) return;
  xrPlanes.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    obj.material.transparent = true;
    obj.material.opacity = 0.28;
    obj.material.color.setHex(0x7cff9a);
    obj.material.depthWrite = false;
    obj.material.side = THREE.DoubleSide;
  });
}

function showReticleMatrix(matrix, estimated = false) {
  reticle.visible = true;
  reticle.userData.estimated = estimated;
  reticle.matrix.copy(matrix);
  reticle.matrixWorldNeedsUpdate = true;
  const color = estimated ? 0xffcc33 : 0x7cff9a;
  reticle.material.color.setHex(color);
  if (reticle.children[0]) reticle.children[0].material.color.setHex(color);
}

function applyFallbackReticle() {
  const cam = getViewCamera();
  cam.getWorldPosition(_camPos);
  cam.getWorldDirection(_forward);
  const tableY = _camPos.y - 0.55;
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -tableY);
  _raycaster.set(_camPos, _forward);
  if (!_raycaster.ray.intersectPlane(plane, _hit)) {
    _hit.copy(_camPos).addScaledVector(_forward, 0.5);
    _hit.y = tableY;
  }
  _reticleQuat.identity();
  reticle.matrix.compose(_hit, _reticleQuat, _one);
  showReticleMatrix(reticle.matrix, true);
}

function updateReticleFromPlanes() {
  if (!xrPlanes || !xrPlanes.visible || xrPlanes.children.length === 0) return false;
  const cam = getViewCamera();
  cam.getWorldPosition(_camPos);
  cam.getWorldDirection(_forward);
  _raycaster.set(_camPos, _forward);
  const hits = _raycaster.intersectObject(xrPlanes, true);
  if (!hits.length) return false;
  const hit = hits[0];
  hit.object.getWorldQuaternion(_reticleQuat);
  reticle.matrix.compose(hit.point, _reticleQuat, _one);
  showReticleMatrix(reticle.matrix, false);
  return true;
}

function updateHitTest(frame) {
  const referenceSpace = renderer.xr.getReferenceSpace();
  const session = renderer.xr.getSession();
  if (!session || !referenceSpace) {
    if (!workspacePlaced) reticle.visible = false;
    return;
  }

  if (hitTestSourceRequested === false) {
    session.requestReferenceSpace("viewer").then((viewerSpace) => {
      session.requestHitTestSource({ space: viewerSpace }).then((source) => {
        hitTestSource = source;
      }).catch((err) => {
        console.warn("hit-test source failed", err);
        hitTestSourceRequested = false;
      });
    }).catch((err) => {
      console.warn("viewer space failed", err);
      hitTestSourceRequested = false;
    });
    session.addEventListener("end", () => {
      hitTestSourceRequested = false;
      hitTestSource = null;
    });
    hitTestSourceRequested = true;
  }

  const viewerPose = frame.getViewerPose(referenceSpace);
  if (!viewerPose) {
    if (hadPose && trialActive) trackingLost += 1;
    hadPose = false;
  } else {
    hadPose = true;
  }

  if (workspacePlaced) {
    reticle.visible = false;
    return;
  }

  let found = false;
  if (hitTestSource) {
    const hitTestResults = frame.getHitTestResults(hitTestSource);
    found = hitTestResults.length > 0;
    if (found) {
      const pose = hitTestResults[0].getPose(referenceSpace);
      if (pose) {
        reticle.matrix.fromArray(pose.transform.matrix);
        showReticleMatrix(reticle.matrix, false);
      } else {
        found = false;
      }
    }
  }

  if (hadHit && !found && trialActive) trackingLost += 1;
  hadHit = found;

  if (!found && !updateReticleFromPlanes()) {
    if (viewerPose) {
      applyFallbackReticle();
    } else {
      reticle.visible = false;
      reticle.userData.estimated = true;
    }
  }
}

function animate(_timestamp, frame) {
  if (frame) updateHitTest(frame);
  applyCarry();
  updateHud();
  renderer.render(scene, camera);
}

function main() {
  scene = new THREE.Scene();
  scene.background = isPhone() ? null : new THREE.Color(0x9eb4c4);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 30);
  camera.position.set(0.05, 0.85, 0.95);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.4));
  const dir = new THREE.DirectionalLight(0xffffff, 1.05);
  dir.position.set(0.5, 1.6, 0.7);
  scene.add(dir);

  desktopHelpers = new THREE.Group();
  const debugFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4),
    new THREE.MeshStandardMaterial({ color: 0x8b93a1, roughness: 0.92 })
  );
  debugFloor.rotation.x = -Math.PI / 2;
  desktopHelpers.add(debugFloor);
  const grid = new THREE.GridHelper(4, 20, 0x445566, 0x6a7382);
  grid.position.y = 0.002;
  desktopHelpers.add(grid);
  desktopHelpers.visible = !isPhone();
  scene.add(desktopHelpers);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, isPhone() ? 0 : 1);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  document.body.appendChild(renderer.domElement);

  document.body.appendChild(ARButton.createButton(renderer, sessionInit()));

  xrPlanes = new XRPlanes(renderer);
  xrPlanes.addEventListener("planeschanged", styleDetectedPlanes);
  scene.add(xrPlanes);

  buildReticle();
  buildWorkspace();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  finishBtn.addEventListener("click", finishTrial);
  replaceBtn.addEventListener("click", relocate);
  enterARBtn.addEventListener("click", startAR);
  exitARBtn.addEventListener("click", endAR);
  placeBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    tryPlaceWorkspace();
  });
  techniqueSelect.addEventListener("change", () => setTechnique(techniqueSelect.value));
  participantIdInput.addEventListener("change", () => {
    trialIndexByTechnique = { touch: 0, carry: 0 };
    if (workspacePlaced) beginTrial();
  });

  carryBtn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (!selected) {
      cardStatus.textContent = "Primero toca el cubo para seleccionarlo";
      return;
    }
    carrying = true;
    carryBtn.classList.add("held");
  });
  const releaseCarry = () => {
    carrying = false;
    carryBtn.classList.remove("held");
  };
  carryBtn.addEventListener("pointerup", releaseCarry);
  carryBtn.addEventListener("pointerleave", releaseCarry);
  carryBtn.addEventListener("pointercancel", releaseCarry);

  rotLeftBtn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    startRotHold(1);
  });
  rotRightBtn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    startRotHold(-1);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((name) => {
    rotLeftBtn.addEventListener(name, stopRotHold);
    rotRightBtn.addEventListener(name, stopRotHold);
  });

  setupControllers();
  renderer.xr.addEventListener("sessionstart", onSessionStart);
  renderer.xr.addEventListener("sessionend", onSessionEnd);

  window.addEventListener("keydown", (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (!selected) return;
    if (event.key === "q" || event.key === "Q") selected.rotation.y += CARRY_ROT_STEP;
    if (event.key === "e" || event.key === "E") selected.rotation.y -= CARRY_ROT_STEP;
  });

  updateHud();
  diagnoseAR();
  renderer.setAnimationLoop(animate);
}

window.__A4 = {
  rows,
  finishTrial,
  measureErrors,
  matchingObject,
  downloadCsv,
  get selected() {
    return selected;
  },
  get ghostType() {
    return ghost ? ghost.userData.type : null;
  },
};

main();
