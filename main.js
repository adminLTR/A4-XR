// MAC0623 — A4 Mobile AR Docking
//
// Base: three.js webxr_ar_hittest (reticle + viewer hit-test + tap-to-place).
// Task: place a workspace on a real table, pick the matching piece, dock it
// onto a translucent ghost (x, z, yaw). Two techniques:
//   1. touch  — one-finger drag on the plane, two-finger twist
//   2. carry  — hold a button and move the phone; ↺ ↻ for yaw
//
// Timing starts at the first selection of the *correct* object and ends
// when the user taps Finalizar intento.

import * as THREE from "three";
import { ARButton } from "three/addons/webxr/ARButton.js";

const SIZE = 0.10;
const POS_TOLERANCE_M = 0.02;
const YAW_TOLERANCE_DEG = 10;
const OBJECT_DISTANCE_MIN = 0.30;
const OBJECT_DISTANCE_MAX = 0.50;
const CARRY_ROT_STEP = THREE.MathUtils.degToRad(8);

const SHAPES = [
  { type: "cube", name: "Cubo azul", color: 0x3d8bfd },
  { type: "sphere", name: "Esfera roja", color: 0xe74c3c },
  { type: "pyramid", name: "Pirámide amarilla", color: 0xf1c40f },
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
const downloadBtn = document.getElementById("downloadBtn");
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
const _reticlePos = new THREE.Vector3();
const _reticleQuat = new THREE.Quaternion();
const _reticleScale = new THREE.Vector3();

let scene, camera, renderer;
let reticle, workspace, ghost, desktopHelpers;
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

function shapeInfo(type) {
  return SHAPES.find((s) => s.type === type);
}

function matchingObject() {
  return objects.find((obj) => obj.userData.type === ghost.userData.type) || null;
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
    opacity: ghosted ? 0.42 : 1,
    depthWrite: !ghosted,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0,
  });
}

function makeShapeMesh(type, color, ghosted) {
  const mat = makeMaterial(color, ghosted);
  let mesh;
  if (type === "cube") {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(SIZE, SIZE, SIZE), mat);
  } else if (type === "sphere") {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(SIZE / 2, 28, 18), mat);
  } else {
    mesh = new THREE.Mesh(new THREE.ConeGeometry(SIZE * 0.55, SIZE, 4), mat);
    mesh.rotation.y = Math.PI / 4;
  }
  mesh.position.y = SIZE / 2;
  mesh.castShadow = false;
  return mesh;
}

function makeYawMark(ghosted) {
  const mark = new THREE.Mesh(
    new THREE.BoxGeometry(SIZE * 0.12, SIZE * 0.12, SIZE * 0.42),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      transparent: ghosted,
      opacity: ghosted ? 0.45 : 1,
      roughness: 0.35,
    })
  );
  mark.position.set(0, SIZE * 0.62, SIZE * 0.22);
  mark.userData.ignorePick = false;
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

function createPiece(type, ghosted) {
  const info = shapeInfo(type);
  const group = new THREE.Group();
  group.userData.type = type;
  group.userData.ghosted = ghosted;
  group.userData.baseColor = info.color;
  const mesh = makeShapeMesh(type, info.color, ghosted);
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

function rebuildGhost(type) {
  if (ghost) workspace.remove(ghost);
  ghost = createPiece(type, true);
  ghost.name = "ghost";
  workspace.add(ghost);
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

  objects = SHAPES.map((s) => {
    const piece = createPiece(s.type, false);
    piece.name = s.type;
    workspace.add(piece);
    return piece;
  });

  rebuildGhost("cube");
  scene.add(workspace);
}

function buildReticle() {
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.10, 0.14, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x7cff9a, transparent: true, opacity: 0.95 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  reticle.userData.estimated = true;
  scene.add(reticle);

  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(0.012, 16).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x7cff9a })
  );
  reticle.add(inner);
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
  const targetType = SHAPES[Math.floor(Math.random() * SHAPES.length)].type;
  rebuildGhost(targetType);
  ghost.position.set(0, 0, 0);
  ghost.rotation.set(0, Math.random() * Math.PI * 2, 0);

  camera.getWorldPosition(_camPos);
  workspace.worldToLocal(_local.copy(_camPos));
  _local.y = 0;
  if (_local.lengthSq() < 1e-6) _local.set(0, 0, 1);
  _local.normalize();

  const facing = Math.atan2(_local.x, _local.z);
  const spreads = [-1.15, 0, 1.15];
  const shuffled = [...objects].sort(() => Math.random() - 0.5);
  shuffled.forEach((piece, i) => {
    const dist = THREE.MathUtils.lerp(
      OBJECT_DISTANCE_MIN,
      OBJECT_DISTANCE_MAX,
      Math.random()
    );
    const angle = facing + spreads[i];
    piece.position.set(Math.sin(angle) * dist, 0, Math.cos(angle) * dist);
    piece.rotation.set(0, Math.random() * Math.PI * 2, 0);
  });

  clearSelection();
  applyDockedLook(false);
}

function placeWorkspaceFromReticle() {
  reticle.matrix.decompose(_reticlePos, _reticleQuat, _reticleScale);
  workspace.position.copy(_reticlePos);
  workspace.quaternion.copy(_reticleQuat);
  workspace.scale.set(1, 1, 1);
  workspace.visible = true;
  workspacePlaced = true;
  reticle.visible = false;
  updateWorkPlane();
  beginTrial();
}

function placeWorkspaceDesktop(point) {
  workspace.position.copy(point);
  workspace.quaternion.identity();
  workspace.visible = true;
  workspacePlaced = true;
  reticle.visible = false;
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
  updateHud();
}

function relocate() {
  workspace.visible = false;
  workspacePlaced = false;
  trialActive = false;
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
  if (body) {
    body.material.emissive.setHex(on ? 0xffffff : 0x000000);
    body.material.emissiveIntensity = on ? 0.28 : 0;
  }
  if (ring) ring.visible = on;
}

function clearSelection() {
  if (selected) highlightPiece(selected, false);
  selected = null;
}

function selectPiece(piece) {
  if (selected === piece) return;
  if (selected) highlightPiece(selected, false);
  selected = piece;
  highlightPiece(piece, true);

  if (trialActive && piece.userData.type !== ghost.userData.type) {
    wrongSelections += 1;
  }
  if (trialActive && piece.userData.type === ghost.userData.type && !correctSelectTime) {
    correctSelectTime = performance.now();
  }
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
  _raycaster.setFromCamera(pointerToNDC(event), camera);
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
  _raycaster.setFromCamera(pointerToNDC(event), camera);
  return _raycaster.ray.intersectPlane(_workPlane, _hit) ? _hit : null;
}

function intersectWorkPlaneCenter() {
  updateWorkPlane();
  _raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
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

function applyFallbackReticle() {
  camera.updateMatrixWorld(true);
  camera.getWorldPosition(_camPos);
  camera.getWorldDirection(_forward);
  const tableY = _camPos.y - 0.4;
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -tableY);
  _raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  if (!_raycaster.ray.intersectPlane(plane, _hit)) {
    _hit.copy(_camPos).addScaledVector(_forward, 0.55);
    _hit.y = tableY;
  }
  _reticleQuat.identity();
  _reticleScale.set(1, 1, 1);
  reticle.matrix.compose(_hit, _reticleQuat, _reticleScale);
  reticle.visible = true;
  reticle.userData.estimated = true;
  reticle.material.color.setHex(0xffcc33);
  if (reticle.children[0]) reticle.children[0].material.color.setHex(0xffcc33);
}

function tryPlaceWorkspace() {
  if (workspacePlaced || !isPresenting()) return;
  if (!reticle.visible) applyFallbackReticle();
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
    return;
  }

  if (dragging && technique === "touch") {
    const point = intersectWorkPlane(event);
    if (point) setPieceOnPlane(selected, point);
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
  if (point) setPieceOnPlane(selected, point);
}

function nudgeYaw(dir) {
  if (!selected) return;
  selected.rotation.y += dir * CARRY_ROT_STEP;
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
  const body = ghost.getObjectByName("body");
  if (body) {
    body.material.emissive.setHex(on ? 0x33ff66 : 0x000000);
    body.material.emissiveIntensity = on ? 0.35 : 0;
  }
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

  const info = ghost ? shapeInfo(ghost.userData.type) : null;
  const errors = measureErrors();
  const match = matchingObject();
  const wrong = selected && match && selected !== match;

  errorCard.classList.toggle("in-tolerance", Boolean(errors.docked));
  errorCard.classList.toggle("wrong-selected", Boolean(wrong));
  applyDockedLook(Boolean(errors.docked));

  if (!presenting) {
    trialCountEl.textContent = `Intento ${trialIndexByTechnique[technique] + 1}`;
    carryBar.hidden = true;
    if (aimEl) aimEl.hidden = true;
    if (placeBtn) placeBtn.hidden = true;
    return;
  }

  if (aimEl) aimEl.hidden = workspacePlaced;
  if (placeBtn) placeBtn.hidden = workspacePlaced;

  if (!workspacePlaced) {
    const tracked = reticle.visible && !reticle.userData.estimated;
    cardTitle.textContent = tracked ? "Superficie detectada" : "Apunta a una mesa";
    posErrorEl.textContent = "—";
    yawErrorEl.textContent = "—";
    cardStatus.textContent = tracked
      ? "Toca la pantalla o pulsa Colocar piezas aquí"
      : "Inclina el teléfono hacia la mesa (luz + textura, no un tablero blanco). Muévelo en círculos lentos. Si no aparece el anillo verde, pulsa Colocar igual: las piezas salen frente a ti.";
  } else {
    cardTitle.textContent = info ? `Fantasma: ${info.name}` : "Fantasma";
    posErrorEl.textContent = errors.posCm == null ? "—" : `${errors.posCm.toFixed(1)} cm`;
    yawErrorEl.textContent = errors.yawDeg == null ? "—" : `${errors.yawDeg.toFixed(1)}°`;
    if (wrong) {
      cardStatus.textContent = "Pieza incorrecta seleccionada — elige la del mismo color";
    } else if (errors.docked) {
      cardStatus.textContent = "Encajado — pulsa Finalizar intento";
    } else if (selected) {
      cardStatus.textContent = technique === "carry"
        ? "Mantén Llevar y mueve el teléfono; ↺ ↻ rotan"
        : "Arrastra con un dedo; gira con dos";
    } else {
      cardStatus.textContent = "Toca la pieza que coincide con el fantasma";
    }
  }

  trialCountEl.textContent = `Intento ${trialIndexByTechnique[technique] + 1}`;
  carryBar.hidden = technique !== "carry";
  if (placeBtn && workspacePlaced) placeBtn.hidden = true;
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
    optionalFeatures: ["dom-overlay"],
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
        "Pulsa <b>Entrar en AR</b> o el botón naranja <b>START AR</b> abajo. Luego apunta a una mesa hasta que aparezca el retículo y toca para colocar."
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
    renderer.xr.setReferenceSpaceType("local");
    const session = await navigator.xr.requestSession("immersive-ar", sessionInit());
    await renderer.xr.setSession(session);
  } catch (err) {
    setGateMessage(
      "No se pudo iniciar AR",
      `El navegador rechazó la sesión: <b>${err.message}</b>.`
    );
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
  hitTestSource = null;
  hitTestSourceRequested = false;
  restoreOverlay();
  window.setTimeout(restoreOverlay, 0);
  camera.position.set(0.05, 0.85, 0.95);
  camera.lookAt(0, 0, 0);
  updateHud();
}

function requestHitTest(session) {
  if (hitTestSourceRequested) return;
  hitTestSourceRequested = true;
  session.requestReferenceSpace("viewer").then((viewerSpace) => {
    const options = { space: viewerSpace };
    if (typeof XRRay === "function") options.offsetRay = new XRRay();
    return session.requestHitTestSource(options);
  }).then((source) => {
    hitTestSource = source;
  }).catch((err) => {
    console.warn("hit-test source failed", err);
    window.setTimeout(() => {
      hitTestSourceRequested = false;
    }, 600);
  });
  session.addEventListener("end", () => {
    hitTestSourceRequested = false;
    hitTestSource = null;
  });
}

function updateHitTest(frame) {
  const referenceSpace = renderer.xr.getReferenceSpace();
  const session = renderer.xr.getSession();
  if (!session || !referenceSpace) return;

  requestHitTest(session);

  const pose = frame.getViewerPose(referenceSpace);
  if (!pose) {
    if (hadPose && trialActive) trackingLost += 1;
    hadPose = false;
    if (!workspacePlaced) applyFallbackReticle();
    return;
  }
  hadPose = true;

  let found = false;
  if (hitTestSource) {
    const results = frame.getHitTestResults(hitTestSource);
    found = results.length > 0;
    if (hadHit && !found && trialActive) trackingLost += 1;
    hadHit = found;

    if (!workspacePlaced && found) {
      const hitPose = results[0].getPose(referenceSpace);
      if (hitPose) {
        reticle.visible = true;
        reticle.userData.estimated = false;
        reticle.matrix.fromArray(hitPose.transform.matrix);
        reticle.material.color.setHex(0x7cff9a);
        if (reticle.children[0]) reticle.children[0].material.color.setHex(0x7cff9a);
        return;
      }
    }
  }

  if (!workspacePlaced) applyFallbackReticle();
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
  document.body.appendChild(renderer.domElement);

  document.body.appendChild(ARButton.createButton(renderer, sessionInit()));

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
  downloadBtn.addEventListener("click", downloadCsv);
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
      cardStatus.textContent = "Primero toca una pieza para seleccionarla";
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
  get selected() {
    return selected;
  },
  get ghostType() {
    return ghost ? ghost.userData.type : null;
  },
};

main();
