let MODELS = {};

const EFFECT_TYPES = [
  "bounce", "bob", "sway", "pulse", "hop", "shake", "nod", "wiggle",
  "stretch", "squash", "float", "step", "lean", "tremble",
];

// All pets share the visible frame calibrated from tutu's F_ attachments.
const REFERENCE_MODEL_BOUNDS = window.RelaxEyesSpinePetAdapter.REFERENCE_MODEL_BOUNDS;

const canvas = document.getElementById("pet-canvas");
const imageCanvas = document.getElementById("image-canvas");
const loading = document.getElementById("loading");
const errorPanel = document.getElementById("error");
const reminder = document.getElementById("reminder");
const petEffects = document.getElementById("pet-effects");
const reminderTitle = document.querySelector("#reminder strong");
const reminderBody = document.querySelector("#reminder span");

let gl = null;
let shader = null;
let batcher = null;
let skeletonRenderer = null;
let mvp = null;
let imageContext = null;
let currentModel = null;
let currentState = null;
let lastFrameTime = 0;
let animationFrame = 0;
let pointer = null;
let audioContext = null;
let idleTimer = null;
let petCatalog = [];
let interactionCatalog = [];
let activeBehavior = null;
let reminderMotion = null;
let appliedReminderMotion = { x: 0, y: 0 };
let codexNotifications = [];
const acknowledgedCodexIds = new Set();
let hovered = false;
let lastHoverAt = 0;
let lastClickAt = 0;
let clickStreak = 0;
let lastContentInsetsReport = null;
let mouseEventsIgnored = null;
let viewportDirty = true;
let geometryRefreshAt = 0;
let appliedBehaviorEffect = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
let appliedModelTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

const IDLE_DELAY_MIN_MS = 5500;
const IDLE_DELAY_MAX_MS = 12000;
const ACTION_DEFAULT_COOLDOWN_MS = 1800;
const LONG_PRESS_MS = 650;
const MULTI_CLICK_WINDOW_MS = 520;
const REMINDER_MOTION_CYCLE_MS = 2200;
const REMINDER_WINDOW_MOVE_INTERVAL_MS = 35;
const REMINDER_WINDOW_MIN_SPEED_PX = 12;
const REMINDER_WINDOW_MAX_SPEED_PX = 72;
const REMINDER_WINDOW_STEP_RATIO = 0.22;
const CODEX_TRANSIENT_DURATION_MS = 7000;
const HOVER_COOLDOWN_MS = 1800;
const DUE_CLICK_GRACE_MS = 220;
const MAX_CAMERA_MULTIPLIER = 1.7;
const DEFAULT_SPEECH_FACE_ANCHOR = { x: 0.62, y: 0.76 };
function isRasterPet(model) {
  return model?.engine === "image" || model?.engine === "sprite" || model?.engine === "codex-webp";
}

function isCodexPet(model = currentModel) {
  return model?.engine === "codex-webp";
}

function directionSign(value) {
  if (typeof value === "number") return value < 0 ? -1 : 1;
  return value === "left" ? -1 : 1;
}

function codexMovementAnimation(
  direction = pointer?.dragDirection ?? reminderMotion?.direction ?? currentState?.facing,
) {
  return directionSign(direction) < 0 ? "running-left" : "running-right";
}

function codexInteractionAnimation(kind) {
  if (kind === "drag-start" || kind === "drag") return codexMovementAnimation();
  if (kind === "drag-end") return "idle";
  return ["doubleClick", "tripleClick", "longPress"].includes(kind)
    ? "jumping"
    : "waving";
}

function codexStatusAnimation(status) {
  return {
    started: "running",
    waiting_confirmation: "waiting",
    completed: "review",
    failed: "failed",
  }[status] || "idle";
}

const CODEX_ACCENTS = {
  completed: { accent: "#45d483", soft: "rgba(69, 212, 131, 0.28)", background: "rgba(240, 252, 245, 0.98)", foreground: "#171512", bodyForeground: "rgba(23, 21, 18, 0.78)" },
  waiting_confirmation: { accent: "#ffd166", soft: "rgba(255, 209, 102, 0.32)", background: "rgba(255, 249, 224, 0.98)", foreground: "#171512", bodyForeground: "rgba(23, 21, 18, 0.78)" },
  failed: { accent: "#ff6b6b", soft: "rgba(255, 107, 107, 0.3)", background: "rgba(255, 240, 240, 0.98)", foreground: "#171512", bodyForeground: "rgba(23, 21, 18, 0.78)" },
  started: { accent: "#71b7ff", soft: "rgba(113, 183, 255, 0.28)", background: "rgba(239, 247, 255, 0.98)", foreground: "#171512", bodyForeground: "rgba(23, 21, 18, 0.78)" },
};
const DEFAULT_REMINDER_ACCENT = { accent: "#ff9c60", soft: "rgba(255, 178, 105, 0.44)", background: "rgba(58, 28, 24, 0.94)", foreground: "#fff8f2", bodyForeground: "rgba(255, 248, 242, 0.76)" };
const INTERACTION_BINDINGS = Object.freeze({
  click: ["greet", "gentle-greet", "sit-nod", "playful", "check-in", "tiny-response", "shy"],
  doubleClick: ["enthusiastic-greet", "playful", "check-in", "special-show"],
  tripleClick: ["grand-routine", "daily-routine", "playful"],
  longPress: ["sit-nod", "shy", "sleepy-response", "companion"],
  hover: ["gentle-greet", "tiny-response", "shy", "sit-nod", "check-in"],
  "drag-start": ["short-walk", "peek-around", "playful"],
  "drag-end": ["settle-down", "tiny-response", "check-in"],
  "codex-ack": ["gentle-greet", "tiny-response", "check-in"],
});
const REGION_BINDINGS = Object.freeze({
  head: ["gentle-greet", "sit-nod", "shy", "peek-around"],
  body: ["greet", "playful", "check-in", "tiny-response"],
  lower: ["sit-nod", "short-walk", "restless"],
  left: ["peek-around", "shy", "check-in"],
  right: ["greet", "enthusiastic-greet", "playful"],
});

function showLoading(message) {
  loading.textContent = message;
  loading.hidden = false;
  errorPanel.hidden = true;
}

function hideLoading() {
  loading.hidden = true;
}

function showError(error) {
  loading.hidden = true;
  errorPanel.hidden = false;
  errorPanel.textContent = `宠物加载失败\n${error instanceof Error ? error.message : String(error)}`;
}

function initializeRenderer() {
  if (gl) return;
  gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: true,
    // Pixel alpha is used by the transparent-window hit test after a frame
    // has been presented. Keep the buffer available until hit testing no
    // longer depends on readPixels.
    preserveDrawingBuffer: true,
  }) || canvas.getContext("experimental-webgl", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("当前环境没有可用的 WebGL");
  shader = spine.webgl.Shader.newTwoColoredTextured(gl);
  batcher = new spine.webgl.PolygonBatcher(gl);
  skeletonRenderer = new spine.webgl.SkeletonRenderer(gl);
  mvp = new spine.webgl.Matrix4();
  imageContext = imageCanvas?.getContext("2d", { alpha: true }) || null;
  gl.enable(gl.BLEND);
}

function clampContentInset(value) {
  return Math.max(0, Math.min(0.45, Number.isFinite(Number(value)) ? Number(value) : 0));
}

function reportContentInsets() {
  const bounds = currentModel?.contentBounds;
  const viewport = currentModel?.viewport;
  if (!bounds || !viewport || !window.relaxEyes?.setContentInsets) return;
  const worldLeft = viewport.centerX - viewport.worldWidth / 2;
  const worldBottom = viewport.centerY - viewport.worldHeight / 2;
  const worldTop = viewport.centerY + viewport.worldHeight / 2;
  const nextInsets = {
    left: clampContentInset((bounds.offset.x - worldLeft) / viewport.worldWidth),
    top: clampContentInset((worldTop - (bounds.offset.y + bounds.size.y)) / viewport.worldHeight),
    right: clampContentInset((worldLeft + viewport.worldWidth - (bounds.offset.x + bounds.size.x)) / viewport.worldWidth),
    bottom: clampContentInset((bounds.offset.y - worldBottom) / viewport.worldHeight),
  };
  if (lastContentInsetsReport && Object.keys(nextInsets).every((key) => Math.abs(nextInsets[key] - lastContentInsetsReport[key]) < 0.002)) {
    return;
  }
  lastContentInsetsReport = nextInsets;
  window.relaxEyes.setContentInsets(nextInsets);
}

function pointInTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(denominator) < 0.0001) return false;
  const first = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
  const second = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
  const third = 1 - first - second;
  return first >= -0.001 && second >= -0.001 && third >= -0.001;
}

function pointInHitPolygons(x, y, polygons) {
  for (const polygon of polygons || []) {
    const vertices = polygon.vertices;
    const indices = polygon.indices;
    for (let index = 0; index + 2 < indices.length; index += 3) {
      const first = indices[index] * 2;
      const second = indices[index + 1] * 2;
      const third = indices[index + 2] * 2;
      if (pointInTriangle(
        x,
        y,
        vertices[first],
        vertices[first + 1],
        vertices[second],
        vertices[second + 1],
        vertices[third],
        vertices[third + 1],
      )) return true;
    }
  }
  return false;
}

function renderedPixelIsOpaque(event, rect) {
  if (isRasterPet(currentModel) && imageContext && imageCanvas?.width && imageCanvas?.height) {
    const horizontal = (event.clientX - rect.left) / rect.width;
    const vertical = (event.clientY - rect.top) / rect.height;
    if (horizontal < 0 || horizontal > 1 || vertical < 0 || vertical > 1) return false;
    try {
      const pixel = imageContext.getImageData(
        Math.max(0, Math.min(imageCanvas.width - 1, Math.floor(horizontal * imageCanvas.width))),
        Math.max(0, Math.min(imageCanvas.height - 1, Math.floor(vertical * imageCanvas.height))),
        1,
        1,
      ).data;
      return pixel[3] >= 12;
    } catch {
      return null;
    }
  }
  if (!gl || !canvas.width || !canvas.height) return null;
  const horizontal = (event.clientX - rect.left) / rect.width;
  const vertical = (event.clientY - rect.top) / rect.height;
  if (horizontal < 0 || horizontal > 1 || vertical < 0 || vertical > 1) return false;
  const pixelX = Math.max(0, Math.min(canvas.width - 1, Math.floor(horizontal * canvas.width)));
  const pixelY = Math.max(0, Math.min(canvas.height - 1, Math.floor((1 - vertical) * canvas.height)));
  const pixel = new Uint8Array(4);
  try {
    gl.readPixels(pixelX, pixelY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    if (gl.getError() !== gl.NO_ERROR) return null;
    return pixel[3] >= 12;
  } catch {
    return null;
  }
}

async function loadInteractionCatalog() {
  const response = await fetch("/interactions.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`互动动作目录加载失败: ${response.status}`);
  const actions = await response.json();
  interactionCatalog = Array.isArray(actions) ? actions : [];
  return interactionCatalog;
}

async function loadPetCatalog() {
  const catalog = await window.RelaxEyesPetCatalog.load();
  petCatalog = catalog.pets;
  MODELS = Object.fromEntries(petCatalog.map((pet) => [pet.id, pet]));
  return petCatalog;
}

function resolveAnimationName(name) {
  const requested = isCodexPet() && String(name || "").toLowerCase() === "move"
    ? codexMovementAnimation()
    : name;
  return currentModel?.adapter?.resolveAnimationName(requested) || null;
}

function findAnimation(name, fallback = "Relax") {
  return resolveAnimationName(name)
    || resolveAnimationName(fallback)
    || currentModel?.skeleton?.data?.animations?.[0]?.name;
}

function hasAnimation(name) {
  return Boolean(resolveAnimationName(name));
}

function buildIdleAnimationPool(model, rawAnimations, idleAnimationName) {
  if (model?.engine === "codex-webp") {
    return rawAnimations.includes(idleAnimationName) ? [idleAnimationName] : rawAnimations.slice(0, 1);
  }
  const configured = Array.isArray(model?.idleAnimations)
    ? model.idleAnimations.filter((name) => rawAnimations.includes(name))
    : [];
  const pool = configured.length ? configured : rawAnimations.slice();
  const nonIdle = pool.filter((name) => name !== idleAnimationName);
  return nonIdle.length ? nonIdle : pool;
}

function chooseIdleAnimation(excluded = []) {
  const pool = currentModel?.idleAnimations || [];
  if (!pool.length) return null;
  const recent = currentModel.recentIdleAnimations || [];
  const excludedSet = new Set(excluded);
  let choices = pool.filter((name) => !excludedSet.has(name) && !recent.includes(name));
  if (!choices.length) choices = pool.filter((name) => !excludedSet.has(name));
  if (!choices.length) choices = pool;
  const selected = choices[Math.floor(Math.random() * choices.length)];
  currentModel.recentIdleAnimations = [...recent.filter((name) => name !== selected), selected].slice(-3);
  return selected;
}

function actionPolicy(action) {
  const modelPolicy = currentModel?.definition?.actions || {};
  const cooldownValue = Number(action?.cooldownMs ?? modelPolicy.cooldownMs ?? ACTION_DEFAULT_COOLDOWN_MS);
  const weightValue = Number(action?.weight ?? 1);
  return {
    cooldownMs: Number.isFinite(cooldownValue) ? Math.max(0, cooldownValue) : ACTION_DEFAULT_COOLDOWN_MS,
    weight: Number.isFinite(weightValue) ? Math.max(0.05, weightValue) : 1,
    interruptible: action?.interruptible ?? modelPolicy.interruptible ?? true,
  };
}

function calibratedBounds(bounds, model) {
  const correction = model?.calibration || {};
  const scaleX = Number.isFinite(Number(correction.scaleX)) ? Number(correction.scaleX) : 1;
  const scaleY = Number.isFinite(Number(correction.scaleY)) ? Number(correction.scaleY) : 1;
  const offsetX = Number.isFinite(Number(correction.offsetX)) ? Number(correction.offsetX) : 0;
  const offsetY = Number.isFinite(Number(correction.offsetY)) ? Number(correction.offsetY) : 0;
  return {
    offset: {
      x: Number(bounds.offset.x) * scaleX + offsetX,
      y: Number(bounds.offset.y) * scaleY + offsetY,
    },
    size: {
      x: Math.abs(Number(bounds.size.x) * scaleX),
      y: Math.abs(Number(bounds.size.y) * scaleY),
    },
  };
}

function actionIsOnCooldown(action) {
  const until = currentModel?.actionCooldowns?.get(action?.id) || 0;
  return until > performance.now();
}

function weightedActionChoice(candidates) {
  if (!candidates.length) return null;
  const totalWeight = candidates.reduce((total, action) => total + actionPolicy(action).weight, 0);
  let cursor = Math.random() * totalWeight;
  for (const action of candidates) {
    cursor -= actionPolicy(action).weight;
    if (cursor <= 0) return action;
  }
  return candidates[candidates.length - 1];
}

function chooseInteractionAction(candidates, { forIdle = false } = {}) {
  const unique = [...new Map(candidates.map((action) => [action.id, action])).values()];
  const available = unique.filter((action) => !actionIsOnCooldown(action));
  if (!available.length) return null;
  const recent = currentModel?.recentActions || [];
  const recentIdle = currentModel?.recentIdleActions || [];
  const fresh = available.filter((action) => !recent.includes(action.id)
    && (!forIdle || !recentIdle.includes(action.id)));
  return weightedActionChoice(fresh.length ? fresh : available);
}

function recordAction(action, policy, source) {
  if (!currentModel || !action?.id) return;
  currentModel.actionCooldowns.set(action.id, performance.now() + policy.cooldownMs);
  currentModel.recentActions = [
    ...(currentModel.recentActions || []).filter((id) => id !== action.id),
    action.id,
  ].slice(-8);
  if (source === "idle") {
    currentModel.recentIdleActions = [
      ...(currentModel.recentIdleActions || []).filter((id) => id !== action.id),
      action.id,
    ].slice(-4);
  }
}

function playIdleAnimationSequence() {
  if (!currentModel) return false;
  if (isCodexPet()) {
    playAnimation(currentModel.idleAnimationName || "idle", true, { force: true, scheduleIdle: false });
    scheduleIdleActivity(randomIdleDelay());
    return true;
  }
  currentModel.idleSequenceEndsAt = 0;
  const interactionCandidates = interactionCatalog.filter((action) => {
    const steps = expandActionSteps(action);
    return steps.length > 0 && steps.some((step) => step.name !== currentModel.idleAnimationName);
  });
  const selected = chooseInteractionAction(interactionCandidates, { forIdle: true });
  if (selected) {
    const steps = expandActionSteps(selected);
    const durationMs = Math.max(900, estimateActionDuration(steps) * 1000);
    const played = playInteractionAction(selected, true, { source: "idle", scheduleIdle: false });
    if (played) scheduleIdleSequence(durationMs);
    return played;
  }

  const names = [];
  const first = chooseIdleAnimation();
  if (first) names.push(first);
  if (names.length && currentModel.idleAnimations.length > 1 && Math.random() < 0.45) {
    const second = chooseIdleAnimation(names);
    if (second) names.push(second);
  }
  if (names.length && currentModel.idleAnimations.length > 2 && Math.random() < 0.2) {
    const third = chooseIdleAnimation(names);
    if (third) names.push(third);
  }
  if (!names.length) {
    playAnimation(currentModel.idleAnimationName || "Relax", true);
    return true;
  }

  clearBehavior();
  currentModel.state.setAnimation(0, names[0], false);
  for (const name of names.slice(1)) currentModel.state.addAnimation(0, name, false, 0.08);
  const idle = currentModel.idleAnimationName || findAnimation("Relax", names[names.length - 1]);
  if (idle) currentModel.state.addAnimation(0, idle, true, 0.05);
  scheduleIdleSequence(estimateAnimationSequenceDuration(names) * 1000);
  return true;
}

function removeBehaviorEffect() {
  const root = currentModel?.skeleton.bones[0];
  if (root) {
    root.x -= appliedBehaviorEffect.x;
    root.y -= appliedBehaviorEffect.y;
    root.rotation -= appliedBehaviorEffect.rotation;
    root.scaleX /= appliedBehaviorEffect.scaleX;
    root.scaleY /= appliedBehaviorEffect.scaleY;
  }
  appliedBehaviorEffect = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
}

function removeReminderMotion() {
  const root = currentModel?.skeleton.bones[0];
  if (root) {
    root.x -= appliedReminderMotion.x;
    root.y -= appliedReminderMotion.y;
  }
  appliedReminderMotion = { x: 0, y: 0 };
}

function restoreReminderWindow(motion) {
  if (!motion?.origin || !window.relaxEyes?.moveWindow) return;
  const restore = () => {
    try {
      const result = window.relaxEyes.moveWindow(motion.origin.x, motion.origin.y);
      if (result?.catch) result.catch(() => {});
    } catch {
      // Window restoration is best effort; host-side drag bounds remain authoritative.
    }
  };
  if (motion.windowMovePromise?.then) {
    void motion.windowMovePromise.then(restore, restore);
  } else {
    restore();
  }
}

function clampReminderWalkSpeed(value) {
  return Math.max(
    REMINDER_WINDOW_MIN_SPEED_PX,
    Math.min(REMINDER_WINDOW_MAX_SPEED_PX, Number(value) || REMINDER_WINDOW_MIN_SPEED_PX),
  );
}

function defaultReminderWalkSpeed() {
  const width = Number(canvas.clientWidth);
  return clampReminderWalkSpeed(Number.isFinite(width) ? width * 0.18 : 32);
}

function reminderWalkStepLimit() {
  const width = Number(canvas.clientWidth);
  return Math.max(8, Math.min(52, Number.isFinite(width) ? width * REMINDER_WINDOW_STEP_RATIO : 32));
}

function observeReminderWalkFrame(delta) {
  const motion = reminderMotion;
  if (!motion || !currentModel) return;
  const entry = currentModel.state.getCurrent(0);
  const isMoveFrame = isCodexPet()
    ? ["running-right", "running-left"].includes(entry?.animation?.name)
    : entry?.animation?.name === currentModel.moveAnimationName;
  if (!isMoveFrame) {
    motion.lastWalkSampleX = null;
    motion.walkSampleMs = 0;
    motion.walkDistance = 0;
    return;
  }
  const rootX = Number(currentModel.skeleton.bones[0]?.x);
  if (!Number.isFinite(rootX)) return;
  const viewportScale = currentModel.viewport && currentModel.viewport.worldWidth > 0
    ? canvas.clientWidth / currentModel.viewport.worldWidth
    : 1;
  const modelScale = Math.abs(Number(currentModel.normalization?.scaleX || 1));
  if (motion.lastWalkSampleX !== null) {
    const frameDistance = Math.abs(rootX - motion.lastWalkSampleX) * modelScale * viewportScale;
    const maxFrameDistance = Math.max(6, canvas.clientWidth * 0.12);
    if (frameDistance <= maxFrameDistance) motion.walkDistance += frameDistance;
  }
  motion.lastWalkSampleX = rootX;
  motion.walkSampleMs += Math.max(0, Number(delta) || 0) * 1000;
  const cycleMs = Math.max(300, Number(currentModel.moveAnimationDuration || 1) * 1000);
  if (motion.walkSampleMs < cycleMs * 0.75) return;
  const stepDistance = Math.min(motion.walkDistance, reminderWalkStepLimit());
  if (stepDistance > 1 && motion.walkSampleMs > 0) {
    motion.walkSpeedPxPerSecond = clampReminderWalkSpeed(
      stepDistance / (motion.walkSampleMs / 1000),
    );
  }
  motion.walkDistance = 0;
  motion.walkSampleMs = 0;
}

function captureAnimationSnapshot() {
  const entry = currentModel?.state.getCurrent(0);
  const name = entry?.animation?.name || currentModel?.idleAnimationName || "Relax";
  return { name, loop: entry?.animation ? Boolean(entry.loop) : true };
}

function stopReminderMotion() {
  const motion = reminderMotion;
  reminderMotion = null;
  removeReminderMotion();
  restoreReminderWindow(motion);
  if (currentModel) {
    const resume = motion?.resumeAnimation || { name: "Relax", loop: true };
    playAnimation(resume.name, resume.loop, { force: true });
  }
}

function syncCodexReminderAnimation(motion) {
  if (!isCodexPet() || !motion) return;
  const animation = codexMovementAnimation(motion.direction);
  const current = currentModel?.state.getCurrent(0)?.animation?.name;
  if (current !== animation) {
    playAnimation(animation, true, { force: true, scheduleIdle: false });
  }
}

function syncCodexDragAnimation(direction) {
  if (!isCodexPet()) return;
  const animation = codexMovementAnimation(direction);
  const current = currentModel?.state.getCurrent(0)?.animation?.name;
  if (current !== animation) {
    playAnimation(animation, true, { force: true, scheduleIdle: false });
  }
}

function requestReminderWindowMove(motion, now) {
  if (!motion?.origin || !Number.isFinite(motion.currentX)
    || now - motion.lastWindowMoveAt < REMINDER_WINDOW_MOVE_INTERVAL_MS
    || motion.windowMovePending || !window.relaxEyes?.moveWindow) return;
  syncCodexReminderAnimation(motion);
  const elapsedMs = Math.max(1, now - motion.lastWindowMoveAt);
  const previousX = motion.currentX;
  const targetX = previousX
    + motion.direction * motion.walkSpeedPxPerSecond * elapsedMs / 1000;
  const requestedDelta = targetX - previousX;
  motion.lastWindowMoveAt = now;
  try {
    const result = window.relaxEyes.moveWindow(targetX, motion.origin.y);
    if (result?.then) {
      motion.windowMovePending = true;
      motion.windowMovePromise = result
        .then((actual) => {
          if (reminderMotion !== motion) return;
          const actualX = Number(actual?.x);
          if (Number.isFinite(actualX)) {
            const actualDelta = actualX - previousX;
            const targetWasClamped = Math.abs(actualX - targetX)
              > Math.max(0.5, Math.abs(requestedDelta) * 0.5);
            const movedTowardTarget = requestedDelta === 0
              || requestedDelta * actualDelta > 0.1;
            if (targetWasClamped || !movedTowardTarget) {
              motion.blockedWindowMoves = (motion.blockedWindowMoves || 0) + 1;
            } else {
              motion.blockedWindowMoves = 0;
            }
            if (targetWasClamped || motion.blockedWindowMoves >= 2) {
              motion.direction *= -1;
              motion.blockedWindowMoves = 0;
              syncCodexReminderAnimation(motion);
            }
            motion.currentX = actualX;
          } else {
            motion.currentX = targetX;
          }
        })
        .catch(() => {})
        .finally(() => {
          motion.windowMovePending = false;
        });
    } else {
      motion.currentX = targetX;
    }
  } catch {
    motion.windowMovePending = false;
  }
}

function applyReminderMotion(now) {
  removeReminderMotion();
  if (!reminderMotion) return;
  const elapsed = Math.max(0, now - reminderMotion.startedAt);
  const progress = (elapsed % REMINDER_MOTION_CYCLE_MS) / REMINDER_MOTION_CYCLE_MS;
  const root = currentModel?.skeleton.bones[0];
  if (!root) return;
  const hopWave = Math.max(0, Math.sin(progress * Math.PI * 8.4));
  appliedReminderMotion = {
    x: 0,
    y: hopWave * REFERENCE_MODEL_BOUNDS.height * 0.025,
  };
  root.y += appliedReminderMotion.y;
  requestReminderWindowMove(reminderMotion, now);
}

function removeModelTransform() {
  const root = currentModel?.skeleton.bones[0];
  if (root) {
    root.x -= appliedModelTransform.x;
    root.y -= appliedModelTransform.y;
    root.scaleX /= appliedModelTransform.scaleX;
    root.scaleY /= appliedModelTransform.scaleY;
  }
  appliedModelTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
}

function applyModelTransform() {
  const root = currentModel?.skeleton.bones[0];
  if (!root || !currentModel.normalization) return;
  const entryName = currentModel.state.getCurrent(0)?.animation?.name;
  const usesNativeCodexDirection = isCodexPet()
    && ["running-right", "running-left"].includes(entryName);
  const facingSign = usesNativeCodexDirection
    ? 1
    : reminderMotion?.direction
      || (currentState?.facing === "left" ? -1 : 1);
  root.x += currentModel.normalization.x;
  root.y += currentModel.normalization.y;
  let mirrorOffset = 0;
  if (facingSign < 0) {
    const mirrorCenterX = Number(currentModel.cameraCenter?.x) || 0;
    mirrorOffset = mirrorCenterX * 2 - root.x * 2;
    root.x += mirrorOffset;
  }
  root.scaleX *= currentModel.normalization.scaleX * facingSign;
  root.scaleY *= currentModel.normalization.scaleY;
  appliedModelTransform = {
    x: currentModel.normalization.x + mirrorOffset,
    y: currentModel.normalization.y,
    scaleX: currentModel.normalization.scaleX * facingSign,
    scaleY: currentModel.normalization.scaleY,
  };
}

function clearBehavior() {
  removeBehaviorEffect();
  activeBehavior = null;
}

function clampProgress(value) {
  return Math.max(0, Math.min(1, value));
}

function actionHash(actionId) {
  return Array.from(actionId || "").reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 7);
}

function createBehaviorEffect(action) {
  const hash = actionHash(action.id);
  const configured = action.effect || {};
  const configuredStrength = Number(configured.strength);
  const configuredCycles = Number(configured.cycles);
  return {
    type: configured.type || EFFECT_TYPES[hash % EFFECT_TYPES.length],
    strength: Number.isFinite(configuredStrength) ? configuredStrength : 0.025 + (hash % 5) * 0.006,
    cycles: Number.isFinite(configuredCycles) ? configuredCycles : 1.1 + (hash % 5) * 0.35,
    phase: (hash % 12) * 0.45,
  };
}

function actionNextIds(action) {
  const configured = action?.next ?? action?.nextAction ?? action?.followUp ?? [];
  return Array.isArray(configured) ? configured : [configured];
}

function expandActionSteps(action, depth = 0, visited = new Set()) {
  if (!action || depth > 2 || (action.id && visited.has(action.id))) return [];
  const nextVisited = new Set(visited);
  if (action.id) nextVisited.add(action.id);
  const steps = [];
  for (const step of action.steps || []) {
    const resolvedName = resolveAnimationName(step.name);
    if (!resolvedName) continue;
    const repeatValue = Number(step.repeat);
    const repeat = Number.isFinite(repeatValue) ? Math.max(1, Math.min(8, Math.round(repeatValue))) : 1;
    const speedValue = Number(step.speed);
    const speed = Number.isFinite(speedValue) ? Math.max(0.55, Math.min(1.35, speedValue)) : 1;
    for (let index = 0; index < repeat; index += 1) {
      const delayValue = Number(index === 0 ? step.delay : step.repeatDelay);
      steps.push({
        name: resolvedName,
        speed,
        delay: Number.isFinite(delayValue) ? Math.max(0, Math.min(1.5, delayValue)) : 0,
      });
    }
  }
  if (depth < 2) {
    for (const nextId of actionNextIds(action)) {
      if (typeof nextId !== "string" || !nextId.trim()) continue;
      const nextAction = interactionCatalog.find((candidate) => candidate.id === nextId.trim());
      if (nextAction) steps.push(...expandActionSteps(nextAction, depth + 1, nextVisited));
    }
  }
  return steps;
}

function estimateActionDuration(steps) {
  return steps.reduce((total, step) => {
    const animation = currentModel.skeleton.data.findAnimation(step.name);
    const duration = Number(animation?.duration);
    return total + (Number.isFinite(duration) ? duration / step.speed : 0.8) + step.delay;
  }, 0);
}

function estimateAnimationSequenceDuration(names) {
  return names.reduce((total, name) => {
    const animation = currentModel?.skeleton?.data?.findAnimation(name);
    const duration = Number(animation?.duration);
    return total + (Number.isFinite(duration) && duration > 0 ? duration : 0.8);
  }, 0) + Math.max(0, names.length - 1) * 0.08 + 0.05;
}

function scheduleIdleSequence(durationMs) {
  if (!currentModel) return;
  const duration = Math.max(900, Number.isFinite(Number(durationMs)) ? Number(durationMs) : 900);
  currentModel.idleSequenceEndsAt = performance.now() + duration;
  scheduleIdleActivity(duration + randomIdleDelay());
}

function playAnimation(name, loop = false, { force = false, scheduleIdle = true } = {}) {
  if (!currentModel || (!force && activeBehavior?.interruptible === false)) return false;
  const resolvedName = findAnimation(name);
  if (!resolvedName) return false;
  if (scheduleIdle) currentModel.idleSequenceEndsAt = 0;
  clearBehavior();
  currentModel.state.setAnimation(0, resolvedName, loop);
  if (!loop) {
    const idle = currentModel.idleAnimationName || findAnimation("Relax", resolvedName);
    currentModel.state.addAnimation(0, idle, true, 0);
    const duration = Number(currentModel.skeleton.data.findAnimation(resolvedName)?.duration);
    currentModel.hoverSuppressedUntil = Math.max(
      currentModel.hoverSuppressedUntil || 0,
      performance.now() + (Number.isFinite(duration) ? duration * 1000 : 900) + 180,
    );
  }
  if (scheduleIdle) scheduleIdleActivity();
  return true;
}

function playInteractionAction(actionId, withEffect = true, {
  force = false,
  source = "interaction",
  scheduleIdle = true,
} = {}) {
  if (!currentModel) return false;
  const action = typeof actionId === "string"
    ? interactionCatalog.find((candidate) => candidate.id === actionId)
    : actionId;
  if (!action) return false;
  const policy = actionPolicy(action);
  if (!force && activeBehavior?.interruptible === false) return false;
  if (source !== "idle") currentModel.idleSequenceEndsAt = 0;
  const steps = expandActionSteps(action);
  if (!steps.length) {
    return playAnimation("Relax", true, { force, scheduleIdle });
  }
  clearBehavior();
  let entry = currentModel.state.setAnimation(0, steps[0].name, false);
  entry.timeScale = steps[0].speed;
  for (const step of steps.slice(1)) {
    entry = currentModel.state.addAnimation(0, step.name, false, step.delay);
    entry.timeScale = step.speed;
  }
  const idle = currentModel.idleAnimationName || findAnimation("Relax", steps[steps.length - 1].name);
  if (idle) currentModel.state.addAnimation(0, idle, true, 0);
  recordAction(action, policy, source);
  const startedAt = performance.now();
  activeBehavior = withEffect
    ? {
      actionId: action.id,
      effect: createBehaviorEffect(action),
      interruptible: policy.interruptible,
      startedAt,
      endsAt: startedAt + Math.max(900, estimateActionDuration(steps) * 1000),
    }
    : null;
  currentModel.hoverSuppressedUntil = Math.max(
    currentModel.hoverSuppressedUntil || 0,
    (activeBehavior?.endsAt || startedAt + 900) + 180,
  );
  if (scheduleIdle) scheduleIdleActivity();
  return true;
}

function playRandomInteraction(ids = null, options = {}) {
  const candidates = interactionCatalog.filter((action) => !ids || ids.includes(action.id));
  const selected = chooseInteractionAction(candidates, { forIdle: options.source === "idle" });
  if (!selected) {
    playAnimation("Interact", false, { force: options.force === true });
    return false;
  }
  return playInteractionAction(selected, true, options);
}

function behaviorEffectValues(effect, progress) {
  const envelope = Math.sin(Math.PI * clampProgress(progress));
  const angle = effect.phase + progress * Math.PI * 2 * effect.cycles;
  const wave = Math.sin(angle);
  const unit = Math.max(REFERENCE_MODEL_BOUNDS.width, REFERENCE_MODEL_BOUNDS.height);
  const amount = unit * effect.strength * envelope;
  switch (effect.type) {
    case "bounce":
      return { x: 0, y: Math.abs(wave) * amount, rotation: 0, scaleX: 1, scaleY: 1 };
    case "bob":
      return { x: 0, y: wave * amount, rotation: 0, scaleX: 1, scaleY: 1 };
    case "sway":
      return { x: 0, y: 0, rotation: wave * effect.strength * 22 * envelope, scaleX: 1, scaleY: 1 };
    case "pulse":
      return { x: 0, y: 0, rotation: 0, scaleX: 1 + wave * effect.strength * envelope, scaleY: 1 - wave * effect.strength * 0.55 * envelope };
    case "hop":
      return { x: 0, y: Math.max(0, wave) * amount * 1.25, rotation: 0, scaleX: 1, scaleY: 1 };
    case "shake":
      return { x: wave * amount * 0.7, y: Math.cos(angle * 1.2) * amount * 0.25, rotation: wave * effect.strength * 14, scaleX: 1, scaleY: 1 };
    case "nod":
      return { x: 0, y: 0, rotation: wave * effect.strength * 28 * envelope, scaleX: 1, scaleY: 1 };
    case "wiggle":
      return { x: wave * amount, y: 0, rotation: Math.cos(angle) * effect.strength * 18 * envelope, scaleX: 1, scaleY: 1 };
    case "stretch":
      return { x: 0, y: 0, rotation: 0, scaleX: 1 - Math.abs(wave) * effect.strength * 0.35 * envelope, scaleY: 1 + Math.abs(wave) * effect.strength * envelope };
    case "squash":
      return { x: 0, y: 0, rotation: 0, scaleX: 1 + Math.abs(wave) * effect.strength * envelope, scaleY: 1 - Math.abs(wave) * effect.strength * 0.45 * envelope };
    case "float":
      return { x: Math.cos(angle) * amount * 0.55, y: wave * amount * 0.65, rotation: 0, scaleX: 1, scaleY: 1 };
    case "step":
      return { x: wave * amount * 0.8, y: Math.abs(Math.cos(angle)) * amount * 0.2, rotation: 0, scaleX: 1, scaleY: 1 };
    case "lean":
      return { x: wave * amount * 0.25, y: 0, rotation: wave * effect.strength * 32 * envelope, scaleX: 1, scaleY: 1 };
    case "tremble":
      return { x: Math.sin(angle * 2.2) * amount * 0.35, y: Math.cos(angle * 2.6) * amount * 0.18, rotation: Math.sin(angle * 2.4) * effect.strength * 10, scaleX: 1, scaleY: 1 };
    default:
      return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  }
}

function applyBehaviorEffect(now) {
  removeBehaviorEffect();
  if (!activeBehavior) return;
  if (now >= activeBehavior.endsAt) {
    activeBehavior = null;
    return;
  }
  const root = currentModel.skeleton.bones[0];
  if (!root) return;
  const values = behaviorEffectValues(activeBehavior.effect, (now - activeBehavior.startedAt) / (activeBehavior.endsAt - activeBehavior.startedAt));
  root.x += values.x;
  root.y += values.y;
  root.rotation += values.rotation;
  root.scaleX *= values.scaleX;
  root.scaleY *= values.scaleY;
  appliedBehaviorEffect = values;
}

function randomIdleDelay() {
  return IDLE_DELAY_MIN_MS + Math.random() * (IDLE_DELAY_MAX_MS - IDLE_DELAY_MIN_MS);
}

function scheduleIdleActivity(delay = randomIdleDelay()) {
  if (idleTimer) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(runIdleActivity, delay);
}

function isAnimationBusy() {
  if (activeBehavior && performance.now() < activeBehavior.endsAt) return true;
  const entry = currentModel?.state.getCurrent(0);
  if (!entry?.animation || entry.loop || entry.animation.name === currentModel?.idleAnimationName) return false;
  return !entry.isComplete();
}

function runIdleActivity() {
  idleTimer = null;
  if (!currentModel || pointer || hasUnderlyingReminder() || activeCodexNotification() || currentState?.paused) {
    scheduleIdleActivity(2500);
    return;
  }
  const sequenceRemaining = Number(currentModel.idleSequenceEndsAt || 0) - performance.now();
  if (sequenceRemaining > 0) {
    scheduleIdleActivity(sequenceRemaining + 80);
    return;
  }
  currentModel.idleSequenceEndsAt = 0;
  if (isAnimationBusy()) {
    scheduleIdleActivity(1800);
    return;
  }

  playIdleAnimationSequence();
}

async function loadModel(modelId, animationName) {
  const model = MODELS[modelId] || MODELS.yao || petCatalog[0];
  if (!model) throw new Error("No usable pet pack is available");
  if (idleTimer) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
  showLoading(`正在加载 ${model.label}`);
  const previousModel = currentModel;
  let adapter = null;
  try {
    removeReminderMotion();
    reminderMotion = null;
    clearBehavior();
    initializeRenderer();
    const isImageModel = isRasterPet(model);
    adapter = model.engine === "codex-webp"
      ? new window.RelaxEyesCodexPetAdapter.CodexPetAdapter(model)
      : model.engine === "sprite"
      ? new window.RelaxEyesSpritePetAdapter.SpritePetAdapter(model)
      : isImageModel
        ? new window.RelaxEyesImagePetAdapter.ImagePetAdapter(model)
      : new window.RelaxEyesSpinePetAdapter(model, gl);
    const loaded = await adapter.load();
    const {
      assetManager,
      skeleton,
      rawAnimations,
      initialAnimationName,
      bounds,
      animationEnvelope,
    } = loaded;
    const animationState = isImageModel
      ? adapter.createAnimationState()
      : (() => {
        const animationStateData = new spine.AnimationStateData(skeleton.data);
        animationStateData.defaultMix = 0.18;
        return new spine.AnimationState(animationStateData);
      })();
    const root = skeleton.bones[0];
    const uniformScale = Math.min(
      REFERENCE_MODEL_BOUNDS.width / bounds.size.x,
      REFERENCE_MODEL_BOUNDS.height / bounds.size.y,
    );
    const cameraBounds = calibratedBounds(
      adapter.transformBounds(animationEnvelope, root, uniformScale),
      model,
    );
    const hitBounds = calibratedBounds(
      adapter.transformBounds(bounds, root, uniformScale),
      model,
    );
    const speechAnchor = model.speechAnchor
      || model.standard?.speechAnchor
      || DEFAULT_SPEECH_FACE_ANCHOR;
    const speechAnchorWorld = {
      x: hitBounds.offset.x + hitBounds.size.x * speechAnchor.x,
      y: hitBounds.offset.y + hitBounds.size.y * speechAnchor.y,
    };
    const bodyCenter = {
      x: hitBounds.offset.x + hitBounds.size.x / 2,
      y: hitBounds.offset.y + hitBounds.size.y / 2,
    };
    const leftExtent = bodyCenter.x - cameraBounds.offset.x;
    const rightExtent = cameraBounds.offset.x + cameraBounds.size.x - bodyCenter.x;
    const bottomExtent = bodyCenter.y - cameraBounds.offset.y;
    const topExtent = cameraBounds.offset.y + cameraBounds.size.y - bodyCenter.y;
    const cameraSize = {
      width: Math.max(
        REFERENCE_MODEL_BOUNDS.width,
        Math.min(REFERENCE_MODEL_BOUNDS.width * MAX_CAMERA_MULTIPLIER, 2 * Math.max(leftExtent, rightExtent)),
      ),
      height: Math.max(
        REFERENCE_MODEL_BOUNDS.height,
        Math.min(REFERENCE_MODEL_BOUNDS.height * MAX_CAMERA_MULTIPLIER, 2 * Math.max(bottomExtent, topExtent)),
      ),
    };
    const nextModel = {
      id: model.id,
      engine: model.engine,
      definition: model,
      adapter,
      assets: assetManager,
      skeleton,
      state: animationState,
      rawAnimations,
      idleAnimationName: initialAnimationName || rawAnimations[0] || null,
      idleSequenceEndsAt: 0,
      moveAnimationName: adapter.resolveAnimationName("Move"),
      behaviorProfile: isCodexPet(model) ? "codex" : "spine",
      moveAnimationDuration: 1,
      idleAnimations: buildIdleAnimationPool(model, rawAnimations, initialAnimationName),
      recentIdleAnimations: [],
      recentIdleActions: [],
      recentActions: [],
      actionCooldowns: new Map(),
      hoverSuppressedUntil: 0,
      bounds,
      displayBounds: null,
      contentBounds: hitBounds,
      hitBounds,
      hitPolygons: [],
      speechFaceBone: findSpeechFaceBone(skeleton),
      speechAnchorWorld,
      cameraBounds,
      cameraCenter: {
        x: bodyCenter.x,
        y: bodyCenter.y,
      },
      cameraSize,
      normalization: {
        x: Number.isFinite(Number(model.calibration?.offsetX)) ? Number(model.calibration.offsetX) : 0,
        y: Number.isFinite(Number(model.calibration?.offsetY)) ? Number(model.calibration.offsetY) : 0,
        scaleX: uniformScale * (Number.isFinite(Number(model.calibration?.scaleX)) ? Number(model.calibration.scaleX) : 1),
        scaleY: uniformScale * (Number.isFinite(Number(model.calibration?.scaleY)) ? Number(model.calibration.scaleY) : 1),
      },
      fitScale: Number.isFinite(Number(model.fitScale)) ? Number(model.fitScale) : 0.68,
    };
    const moveAnimation = nextModel.moveAnimationName
      ? skeleton.data.findAnimation(nextModel.moveAnimationName)
      : null;
    const moveAnimationDuration = Number(moveAnimation?.duration);
    if (Number.isFinite(moveAnimationDuration) && moveAnimationDuration > 0) {
      nextModel.moveAnimationDuration = moveAnimationDuration;
    }
    if (previousModel?.adapter) previousModel.adapter.dispose();
    currentModel = nextModel;
    if (imageCanvas) imageCanvas.hidden = !isImageModel;
    lastContentInsetsReport = null;
    viewportDirty = true;
    geometryRefreshAt = 0;
    appliedModelTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    window.relaxEyes.setAvailableAnimations(model.id, rawAnimations);
    playAnimation(animationName || currentModel.idleAnimationName || model.initialAnimation, model.initialLoop);
    const activeCodex = activeCodexNotification();
    if (isCodexPet() && activeCodex) {
      const status = codexStatus(activeCodex);
      playAnimation(
        codexStatusAnimation(status),
        status === "started" || status === "waiting_confirmation",
        { force: true, scheduleIdle: false },
      );
    }
    if (hasUnderlyingReminder() && !activeCodexNotification()) void startReminderMotion();
    setMousePassthrough(true);
    hideLoading();
    errorPanel.hidden = true;
  } catch (error) {
    if (adapter && adapter !== currentModel?.adapter) adapter.dispose();
    if (currentModel === previousModel) scheduleIdleActivity(2500);
    showError(error);
    console.error(error);
  }
}

function resizeCanvas() {
  if (!gl || !currentModel) return;
  const ratio = Math.max(1, Math.min(1.5, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  const sizeChanged = canvas.width !== width || canvas.height !== height;
  if (sizeChanged) {
    canvas.width = width;
    canvas.height = height;
  }
  if (!viewportDirty && !sizeChanged && currentModel.viewport) return;
  const centerX = currentModel.cameraCenter.x;
  const centerY = currentModel.cameraCenter.y;
  const cameraSize = currentModel.cameraSize;
  const scale = Math.min(
    canvas.width / cameraSize.width,
    canvas.height / cameraSize.height,
  )
    * 0.82 * currentModel.fitScale;
  const worldWidth = canvas.width / scale;
  const worldHeight = canvas.height / scale;
  mvp.ortho2d(centerX - worldWidth / 2, centerY - worldHeight / 2, worldWidth, worldHeight);
  currentModel.viewport = { centerX, centerY, worldWidth, worldHeight };
  reportContentInsets();
  gl.viewport(0, 0, canvas.width, canvas.height);
  viewportDirty = false;
}

function findSpeechFaceBone(skeleton) {
  const bones = skeleton?.bones || [];
  return bones.find((bone) => {
    const name = String(bone?.data?.name || bone?.name || "").toLowerCase();
    return /face|head|mouth/.test(name);
  }) || bones.find((bone) => {
    const name = String(bone?.data?.name || bone?.name || "").toLowerCase();
    return /eye/.test(name);
  }) || null;
}

function updateReminderBubbleAnchor() {
  if (!currentModel || reminder.hidden) return;
  const bounds = currentModel.contentBounds || currentModel.cameraBounds || currentModel.displayBounds;
  const viewport = currentModel.viewport;
  const rect = canvas.getBoundingClientRect();
  if (!bounds || !viewport || !rect.width || !rect.height || !reminder.offsetWidth) return;

  // Use setup-space bounds so animation keys cannot make the bubble jump vertically.
  let faceWorldX = currentModel.speechAnchorWorld?.x
    ?? bounds.offset.x + bounds.size.x * DEFAULT_SPEECH_FACE_ANCHOR.x;
  const faceWorldY = currentModel.speechAnchorWorld?.y
    ?? bounds.offset.y + bounds.size.y * DEFAULT_SPEECH_FACE_ANCHOR.y;
  if (currentState?.facing === "left") {
    const mirrorCenterX = Number(currentModel.cameraCenter?.x) || 0;
    faceWorldX = mirrorCenterX * 2 - faceWorldX;
  }
  const worldLeft = viewport.centerX - viewport.worldWidth / 2;
  const worldTop = viewport.centerY + viewport.worldHeight / 2;
  const faceX = ((faceWorldX - worldLeft) / viewport.worldWidth) * rect.width;
  const faceY = ((worldTop - faceWorldY) / viewport.worldHeight) * rect.height;
  const bubbleWidth = reminder.offsetWidth;
  const bubbleHeight = reminder.offsetHeight;
  const modelTop = ((worldTop - (bounds.offset.y + bounds.size.y)) / viewport.worldHeight) * rect.height;
  const maxLeft = Math.max(4, rect.width - bubbleWidth - 4);
  const bubbleLeft = Math.max(4, Math.min(maxLeft, faceX - bubbleWidth / 2));
  const preferredTop = modelTop - bubbleHeight - 7;
  const top = Math.max(4, Math.min(
    Math.max(4, rect.height - bubbleHeight - 4),
    preferredTop,
  ));
  const tailX = Math.max(12, Math.min(bubbleWidth - 12, faceX - bubbleLeft));
  const tailLength = Math.max(8, Math.min(30, faceY - top - bubbleHeight + 4));
  const bubbleScale = activeCodexNotification()
    ? Math.max(0.7, Math.min(1.4, Number(currentState?.codexBubbleScale ?? 1)))
    : 1;
  reminder.style.left = `${Math.round(bubbleLeft)}px`;
  reminder.style.top = `${Math.round(top)}px`;
  reminder.style.setProperty("--reminder-bubble-scale", String(bubbleScale));
  reminder.style.setProperty("--reminder-tail-x", `${Math.round(tailX)}px`);
  reminder.style.setProperty("--reminder-tail-length", `${Math.round(tailLength)}px`);
}

function renderFrame() {
  animationFrame = requestAnimationFrame(renderFrame);
  if (!gl || !currentModel) return;
  const now = performance.now() / 1000;
  const delta = lastFrameTime ? Math.min(0.1, now - lastFrameTime) : 0;
  lastFrameTime = now;
  removeReminderMotion();
  removeBehaviorEffect();
  removeModelTransform();
  currentModel.state.update(delta);
  currentModel.state.apply(currentModel.skeleton);
  observeReminderWalkFrame(delta);
  applyModelTransform();
  applyBehaviorEffect(performance.now());
  applyReminderMotion(performance.now());
  if (isRasterPet(currentModel)) {
    resizeCanvas();
    // Keep the WebGL canvas as the transparent input layer, but remove the
    // previous Spine frame before revealing the raster canvas underneath it.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (imageContext && imageCanvas) {
      if (imageCanvas.width !== canvas.width || imageCanvas.height !== canvas.height) {
        imageCanvas.width = canvas.width;
        imageCanvas.height = canvas.height;
      }
      imageContext.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
      imageContext.imageSmoothingEnabled = true;
      imageContext.imageSmoothingQuality = "high";
      currentModel.adapter.draw(
        imageContext,
        imageCanvas.width,
        imageCanvas.height,
        currentModel.viewport,
        currentModel.bounds,
        currentModel.skeleton.bones[0],
        currentModel.state.getCurrent(0),
      );
    }
    updateReminderBubbleAnchor();
    return;
  }
  currentModel.skeleton.updateWorldTransform();
  const displayOffset = new spine.Vector2();
  const displaySize = new spine.Vector2();
  currentModel.skeleton.getBounds(displayOffset, displaySize, []);
  if (Number.isFinite(displaySize.x) && Number.isFinite(displaySize.y) && displaySize.x > 0 && displaySize.y > 0) {
    currentModel.displayBounds = { offset: displayOffset, size: displaySize };
  }
  const geometryNow = performance.now();
  if (!isRasterPet(currentModel) && geometryNow >= geometryRefreshAt) {
    try {
      currentModel.hitBounds = currentModel.adapter.collectBounds(currentModel.skeleton);
      currentModel.hitPolygons = currentModel.adapter.collectHitPolygons(currentModel.skeleton);
    } catch {
      currentModel.hitBounds = currentModel.displayBounds || currentModel.hitBounds;
      currentModel.hitPolygons = [];
    }
    geometryRefreshAt = geometryNow + 50;
  }
  resizeCanvas();
  updateReminderBubbleAnchor();
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  shader.bind();
  shader.setUniformi(spine.webgl.Shader.SAMPLER, 0);
  shader.setUniform4x4f(spine.webgl.Shader.MVP_MATRIX, mvp.values);
  batcher.begin(shader);
  skeletonRenderer.premultipliedAlpha = false;
  skeletonRenderer.draw(batcher, currentModel.skeleton);
  batcher.end();
  shader.unbind();
}

function formatRemaining(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function codexEventId(event) {
  return event?.eventId || event?.event_id || "";
}

function codexStatus(event) {
  return event?.status || "";
}

function activeCodexNotification() {
  if (currentState?.codexEnabled === false) return null;
  return codexNotifications.find((item) => codexStatus(item) === "waiting_confirmation")
    || codexNotifications[codexNotifications.length - 1]
    || null;
}

function hasWaitingCodexNotification() {
  return currentState?.codexEnabled !== false
    && codexNotifications.some((item) => codexStatus(item) === "waiting_confirmation");
}

function hasUnderlyingReminder() {
  return currentState?.weeklyReportEnabled !== false
    && Number(currentState?.weeklyReportDueAt || 0) > 0
    || currentState?.eyeBreakEnabled !== false && currentState?.phase === "due";
}

function setReminderTheme(theme = themeFromAccent(DEFAULT_REMINDER_ACCENT)) {
  reminder.style.setProperty("--reminder-accent", theme.accent);
  reminder.style.setProperty("--reminder-accent-soft", theme.soft);
  reminder.style.setProperty("--reminder-background", theme.background);
  reminder.style.setProperty("--reminder-foreground", theme.foreground || "#fff8f2");
  reminder.style.setProperty("--reminder-body-foreground", theme.bodyForeground || "rgba(255, 248, 242, 0.76)");
}

function foregroundForAccent(red, green, blue) {
  const toLinear = (channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue);
  return luminance > 0.42
    ? { foreground: "#171512", bodyForeground: "rgba(23, 21, 18, 0.78)" }
    : { foreground: "#fff8f2", bodyForeground: "rgba(255, 248, 242, 0.76)" };
}

function themeFromAccent(value, fallback = DEFAULT_REMINDER_ACCENT) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || ""));
  if (!match) return fallback;
  const color = Number.parseInt(match[1], 16);
  const red = color >> 16;
  const green = (color >> 8) & 255;
  const blue = color & 255;
  const text = foregroundForAccent(red, green, blue);
  return {
    accent: String(value).toLowerCase(),
    soft: `rgba(${red}, ${green}, ${blue}, 0.5)`,
    background: text.foreground === "#171512"
      ? "rgba(255, 250, 242, 0.97)"
      : `rgba(${red}, ${green}, ${blue}, 0.28)`,
    ...text,
  };
}

function customReminderTheme(value) {
  return themeFromAccent(value, themeFromAccent(DEFAULT_REMINDER_ACCENT));
}

function spawnPetEffect(kind = "interaction") {
  if (!petEffects) return;
  const symbols = kind === "waiting_confirmation"
    ? ["!", "?", "*"]
    : kind === "completed"
      ? ["+", "*", "."]
      : ["*", "+", "."];
  const accent = kind === "waiting_confirmation"
    ? "#ffd166"
    : kind === "completed"
      ? "#45d483"
      : "#ffcf8a";
  for (let index = 0; index < 3; index += 1) {
    const particle = document.createElement("span");
    particle.className = "pet-effect";
    particle.textContent = symbols[index % symbols.length];
    particle.style.setProperty("--effect-x", `${48 + Math.random() * 12}%`);
    particle.style.setProperty("--effect-y", `${42 + Math.random() * 18}%`);
    particle.style.setProperty("--effect-dx", `${Math.round((Math.random() - 0.5) * 44)}px`);
    particle.style.setProperty("--effect-dy", `${Math.round(-24 - Math.random() * 34)}px`);
    particle.style.setProperty("--effect-rotate", `${Math.round((Math.random() - 0.5) * 36)}deg`);
    particle.style.setProperty("--effect-color", accent);
    particle.style.setProperty("--effect-size", `${14 + Math.round(Math.random() * 8)}px`);
    petEffects.appendChild(particle);
    window.setTimeout(() => particle.remove(), 760);
  }
}

function configuredCodexTheme(status) {
  const fallback = CODEX_ACCENTS[status] || CODEX_ACCENTS.started;
  const accentKey = {
    completed: "codexCompletedAccent",
    waiting_confirmation: "codexWaitingAccent",
    failed: "codexFailedAccent",
    started: "codexStartedAccent",
  }[status] || "codexStartedAccent";
  return themeFromAccent(currentState?.[accentKey], fallback);
}

function renderNotificationHud() {
  const codex = activeCodexNotification();
  if (codex) {
    const theme = configuredCodexTheme(codexStatus(codex));
    setReminderTheme(theme);
    reminderTitle.textContent = codex.title || "Codex 状态更新";
    reminderBody.textContent = codex.summary || "Codex 有新的状态更新。";
    reminder.hidden = false;
    document.body.classList.add("is-reminding");
    document.body.classList.add("is-codex-reminding");
    return;
  }
  document.body.classList.remove("is-codex-reminding");
  const weekly = currentState?.weeklyReportEnabled !== false
    && Number(currentState?.weeklyReportDueAt || 0) > 0;
  if (weekly) {
    setReminderTheme(themeFromAccent(currentState?.weeklyReportAccent, CODEX_ACCENTS.failed));
    reminderTitle.textContent = currentState?.weeklyReportTitle || "该写周报了";
    reminderBody.textContent = currentState?.weeklyReportBody || "花几分钟回顾本周完成的工作和下周计划。";
    reminder.hidden = false;
    document.body.classList.add("is-reminding");
    return;
  }
  setReminderTheme(customReminderTheme(currentState?.reminderAccent));
  const due = currentState?.eyeBreakEnabled !== false && currentState?.phase === "due";
  const seconds = Math.round(Number(currentState?.restDurationMs || 20000) / 1000);
  const body = (currentState?.reminderBody || "看向远处 {seconds} 秒，或者点击宠物确认已经休息。")
    .replaceAll("{seconds}", String(seconds))
    .replaceAll("{restSeconds}", String(seconds));
  reminderTitle.textContent = currentState?.reminderTitle || "该放松一下眼睛了";
  reminderBody.textContent = body;
  reminder.hidden = !due;
  document.body.classList.toggle("is-reminding", due);
}

function acknowledgeCodexNotification(eventId) {
  const index = codexNotifications.findIndex((item) => codexEventId(item) === eventId);
  if (index < 0) return Promise.resolve(false);
  const acknowledge = window.relaxEyes?.ackCodexEvent;
  const removeLocally = () => {
    acknowledgedCodexIds.add(eventId);
    codexNotifications = codexNotifications.filter((item) => codexEventId(item) !== eventId);
    renderNotificationHud();
    const next = activeCodexNotification();
    if (next) {
      startCodexAttention(next);
    } else {
      stopReminderMotion();
      if (hasUnderlyingReminder()) startReminderMotion();
    }
    return true;
  };
  if (!acknowledge) return Promise.resolve(removeLocally());
  return acknowledge(eventId)
    .then(() => removeLocally())
    .catch((error) => {
      console.error("Could not acknowledge Codex notification:", error);
      return false;
    });
}

function acknowledgeCurrentCodexNotification() {
  const active = activeCodexNotification();
  if (!active) return false;
  void acknowledgeCodexNotification(codexEventId(active));
  return true;
}

function startCodexAttention(event) {
  if (!event || currentState?.codexEnabled === false) return;
  if (idleTimer) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (reminderMotion) stopReminderMotion();
  if (isCodexPet()) {
    const status = codexStatus(event);
    const loop = status === "started" || status === "waiting_confirmation";
    playAnimation(codexStatusAnimation(status), loop, { force: true, scheduleIdle: false });
  }
  playReminderSound();
  spawnPetEffect(codexStatus(event));
}

function addCodexNotification(event) {
  if (currentState?.codexEnabled === false) return;
  const eventId = codexEventId(event);
  if (!eventId || acknowledgedCodexIds.has(eventId)) return;
  codexNotifications = codexNotifications.filter((item) => codexEventId(item) !== eventId);
  codexNotifications.push(event);
  renderNotificationHud();
  startCodexAttention(activeCodexNotification());
  if (codexStatus(event) !== "waiting_confirmation") {
    window.setTimeout(() => {
      void acknowledgeCodexNotification(eventId);
    }, codexStatus(event) === "started" ? 1800 : CODEX_TRANSIENT_DURATION_MS);
  }
}

function syncPendingCodexNotifications(events) {
  if (currentState?.codexEnabled === false) {
    codexNotifications = [];
    return;
  }
  if (!Array.isArray(events)) return;
  const pendingIds = new Set(events.map(codexEventId).filter(Boolean));
  for (const event of events) {
    const eventId = codexEventId(event);
    if (eventId && !acknowledgedCodexIds.has(eventId)
      && !codexNotifications.some((item) => codexEventId(item) === eventId)) {
      addCodexNotification(event);
    }
  }
  for (const eventId of [...acknowledgedCodexIds]) {
    if (!pendingIds.has(eventId)) acknowledgedCodexIds.delete(eventId);
  }
}

function updateHud(state) {
  currentState = state;
  syncPendingCodexNotifications(state.codexPendingEvents);
  renderNotificationHud();
  if (hasUnderlyingReminder() && !activeCodexNotification()) {
    if (currentModel && !reminderMotion) void startReminderMotion();
  } else if (!hasUnderlyingReminder() && reminderMotion) {
    stopReminderMotion();
  }
}

function playReminderSound() {
  try {
    const volume = Math.max(0, Math.min(1, Number(currentState?.soundVolume ?? 0.65)));
    if (volume <= 0) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext ||= new AudioContextClass();
    if (audioContext.state === "suspended") audioContext.resume();
    const start = audioContext.currentTime;
    [660, 880, 1046, 880].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const noteStart = start + index * 0.16;
      oscillator.type = index === 2 ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.18 * volume, noteStart + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.3);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + 0.32);
    });
  } catch {
    // Audio is a convenience; the system notification and animation remain available.
  }
}

async function startReminderMotion() {
  if (activeCodexNotification()) {
    renderNotificationHud();
    return;
  }
  if (!currentModel || reminderMotion) return;
  const startedAt = performance.now();
  const fallbackPosition = currentState?.position;
  const motion = {
    startedAt,
    origin: fallbackPosition && Number.isFinite(Number(fallbackPosition.x))
      && Number.isFinite(Number(fallbackPosition.y))
      ? { x: Number(fallbackPosition.x), y: Number(fallbackPosition.y) }
      : null,
    direction: currentState?.facing === "left" ? -1 : 1,
    resumeAnimation: captureAnimationSnapshot(),
    currentX: fallbackPosition && Number.isFinite(Number(fallbackPosition.x))
      ? Number(fallbackPosition.x)
      : null,
    walkSpeedPxPerSecond: defaultReminderWalkSpeed(),
    walkSampleMs: 0,
    walkDistance: 0,
    lastWalkSampleX: null,
    lastWindowMoveAt: startedAt,
    windowMovePending: false,
    windowMovePromise: null,
    blockedWindowMoves: 0,
  };
  reminderMotion = motion;
  playReminderSound();
  spawnPetEffect("reminder");
  playAnimation(
    isCodexPet() ? codexMovementAnimation(motion.direction) : "Move",
    true,
    { force: true },
  );
  try {
    const position = await window.relaxEyes.getWindowPosition?.();
    if (reminderMotion === motion && position
      && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))) {
      motion.origin = { x: Number(position.x), y: Number(position.y) };
      motion.currentX = Number(position.x);
    }
  } catch {
    // The persisted position remains a suitable fallback for the reminder run.
  }
}

function worldPointFromEvent(event) {
  const bounds = currentModel?.hitBounds;
  const viewport = currentModel?.viewport;
  const rect = canvas.getBoundingClientRect();
  if (!bounds || !viewport || !rect.width || !rect.height) return null;
  const horizontal = (event.clientX - rect.left) / rect.width;
  const vertical = (event.clientY - rect.top) / rect.height;
  return {
    x: viewport.centerX - viewport.worldWidth / 2 + horizontal * viewport.worldWidth,
    y: viewport.centerY + viewport.worldHeight / 2 - vertical * viewport.worldHeight,
  };
}

function interactionRegionForEvent(event) {
  if (typeof event === "string") return event;
  const point = worldPointFromEvent(event);
  const bounds = currentModel?.hitBounds;
  if (!point || !bounds || !bounds.size.x || !bounds.size.y) return "body";
  const horizontal = (point.x - bounds.offset.x) / bounds.size.x;
  const vertical = (point.y - bounds.offset.y) / bounds.size.y;
  if (vertical >= 0.7) return "head";
  if (vertical <= 0.25) return "lower";
  if (horizontal <= 0.32) return "left";
  if (horizontal >= 0.68) return "right";
  return "body";
}

function interactionIdsFor(kind, region) {
  const base = INTERACTION_BINDINGS[kind] || INTERACTION_BINDINGS.click;
  const regional = REGION_BINDINGS[region] || [];
  return [...new Set([...regional, ...base])];
}

function triggerPetInteraction(kind = "click", region = "body", { force = false } = {}) {
  if (isCodexPet() && kind === "codex-ack") {
    const played = playAnimation("waving", false, { force: true });
    if (played) spawnPetEffect("interaction");
    return played;
  }
  if (currentState?.paused || currentState?.phase === "due" || hasWaitingCodexNotification()) return false;
  if (isCodexPet()) {
    const isDragging = kind === "drag-start" || kind === "drag";
    const played = playAnimation(
      codexInteractionAnimation(kind),
      isDragging,
      { force: true, scheduleIdle: !isDragging },
    );
    if (played) spawnPetEffect("interaction");
    return played;
  }
  const played = playRandomInteraction(
    interactionIdsFor(kind, interactionRegionForEvent(region)),
    { source: kind, force },
  );
  if (played) spawnPetEffect("interaction");
  return played;
}

function nextClickInteraction() {
  const now = performance.now();
  clickStreak = now - lastClickAt <= MULTI_CLICK_WINDOW_MS ? Math.min(3, clickStreak + 1) : 1;
  lastClickAt = now;
  if (clickStreak >= 3) {
    clickStreak = 0;
    return "tripleClick";
  }
  return clickStreak === 2 ? "doubleClick" : "click";
}

function handleEvent(event) {
  if (event.type === "play-action") {
    if (isCodexPet()) {
      playAnimation(event.id || "idle", false, { force: true });
    } else {
      playInteractionAction(event.id, true, { force: true, source: "manual" });
    }
  } else if (event.type === "model-change") {
    loadModel(event.model);
  } else if (event.type === "pet-click") {
    triggerPetInteraction(event.interaction || "click", event.region || "body", { force: true });
  } else if (event.type === "play-animation") {
    playAnimation(event.name, false, { force: true });
  } else if (event.type === "codex-notification") {
    addCodexNotification(event.event);
  } else if (event.type === "codex-event-ack") {
    const eventId = codexEventId(event);
    acknowledgedCodexIds.add(eventId);
    codexNotifications = codexNotifications.filter((item) => codexEventId(item) !== eventId);
    renderNotificationHud();
    const next = activeCodexNotification();
    if (next) startCodexAttention(next);
    else if (hasUnderlyingReminder()) startReminderMotion();
  } else if (event.type === "reminder-due" || event.type === "weekly-report-due") {
    if (activeCodexNotification()
      || (currentState?.weeklyReportEnabled !== false && Number(currentState?.weeklyReportDueAt || 0) > 0)) {
      renderNotificationHud();
    } else {
      reminder.hidden = false;
      document.body.classList.add("is-reminding");
      startReminderMotion();
    }
  } else if (event.type === "timer-reset" || event.type === "weekly-report-reset") {
    if (activeCodexNotification()
      || (currentState?.weeklyReportEnabled !== false && Number(currentState?.weeklyReportDueAt || 0) > 0)) {
      renderNotificationHud();
    } else {
      stopReminderMotion();
      reminder.hidden = true;
      document.body.classList.remove("is-reminding");
      scheduleIdleActivity(2500);
    }
  }
}

async function beginPointer(event) {
  if (event.button !== 0 || !isPointerOverPet(event)) return;
  setMousePassthrough(false);
  const nextPointer = {
    startX: event.screenX,
    startY: event.screenY,
    originX: null,
    originY: null,
    region: interactionRegionForEvent(event),
    moved: false,
    dragAnimationStarted: false,
    dragDirection: directionSign(currentState?.facing),
    longPressTriggered: false,
    longPressTimer: null,
    dueClickConfirmed: false,
    dueClickTimer: null,
    pointerId: event.pointerId,
  };
  pointer = nextPointer;
  canvas.setPointerCapture?.(event.pointerId);
  if (!hasUnderlyingReminder() && !hasWaitingCodexNotification() && !currentState?.paused) {
    nextPointer.longPressTimer = window.setTimeout(() => {
      if (pointer !== nextPointer || nextPointer.moved || nextPointer.longPressTriggered) return;
      nextPointer.longPressTriggered = true;
      triggerPetInteraction("longPress", nextPointer.region, { force: true });
    }, LONG_PRESS_MS);
  }
  if ((currentState?.phase === "due" || Number(currentState?.weeklyReportDueAt || 0) > 0)
    && !hasWaitingCodexNotification()) {
    nextPointer.dueClickTimer = window.setTimeout(() => {
      if (pointer !== nextPointer || nextPointer.moved || nextPointer.dueClickConfirmed) return;
      nextPointer.dueClickConfirmed = true;
      window.relaxEyes.petClick();
    }, DUE_CLICK_GRACE_MS);
  }
  try {
    const origin = await window.relaxEyes.beginDrag();
    if (pointer === nextPointer) {
      nextPointer.originX = origin.x;
      nextPointer.originY = origin.y;
    } else {
      window.relaxEyes.cancelDrag?.();
    }
  } catch {
    window.relaxEyes.cancelDrag?.();
    if (pointer === nextPointer) pointer = null;
  }
}

function movePointer(event) {
  if (!pointer) {
    updateHover(event);
    updateMousePassthrough(event);
    return;
  }
  if (!(event.buttons & 1) || !Number.isFinite(pointer.originX)) return;
  const dx = event.screenX - pointer.startX;
  const dy = event.screenY - pointer.startY;
  if (Math.abs(dx) > 6 || Math.abs(dy) > 6) pointer.moved = true;
  if (pointer.moved && pointer.longPressTimer) {
    window.clearTimeout(pointer.longPressTimer);
    pointer.longPressTimer = null;
  }
  if (pointer.moved && pointer.dueClickTimer) {
    window.clearTimeout(pointer.dueClickTimer);
    pointer.dueClickTimer = null;
  }
  if (pointer.moved) {
    const nextDirection = dx === 0 ? pointer.dragDirection : (dx < 0 ? -1 : 1);
    const directionChanged = nextDirection !== pointer.dragDirection;
    pointer.dragDirection = nextDirection;
    if (!pointer.dragAnimationStarted) {
      pointer.dragAnimationStarted = true;
      if (reminderMotion) stopReminderMotion();
      triggerPetInteraction("drag-start", pointer.region, { force: true });
    } else if (directionChanged) {
      syncCodexDragAnimation(pointer.dragDirection);
    }
    const result = window.relaxEyes.moveWindow(pointer.originX + dx, pointer.originY + dy);
    if (result?.catch) result.catch(() => {});
  }
}

function endPointer(event) {
  if (!pointer) return;
  const finishedPointer = pointer;
  pointer = null;
  if (finishedPointer.longPressTimer) window.clearTimeout(finishedPointer.longPressTimer);
  if (finishedPointer.dueClickTimer) window.clearTimeout(finishedPointer.dueClickTimer);
  if (finishedPointer.moved) {
    const dx = event.screenX - finishedPointer.startX;
    const dy = event.screenY - finishedPointer.startY;
    if (Number.isFinite(finishedPointer.originX)) {
      const result = window.relaxEyes.endDrag(finishedPointer.originX + dx, finishedPointer.originY + dy);
      if (result?.catch) result.catch(() => {});
    }
    triggerPetInteraction("drag-end", finishedPointer.region, { force: true });
  } else {
    if (!finishedPointer.dueClickConfirmed && !finishedPointer.longPressTriggered) {
      const acknowledgedCodex = acknowledgeCurrentCodexNotification();
      if (acknowledgedCodex) {
        triggerPetInteraction("codex-ack", finishedPointer.region, { force: true });
      } else if (hasUnderlyingReminder()) {
        window.relaxEyes.petClick();
      } else {
        triggerPetInteraction(nextClickInteraction(), finishedPointer.region, { force: true });
      }
    }
    window.relaxEyes.cancelDrag?.();
  }
  canvas.releasePointerCapture?.(event.pointerId);
  updateMousePassthrough(event);
}

function isPointerOverPet(event) {
  const bounds = currentModel?.hitBounds;
  const viewport = currentModel?.viewport;
  if (!bounds || !viewport) return false;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const horizontal = (event.clientX - rect.left) / rect.width;
  const vertical = (event.clientY - rect.top) / rect.height;
  if (horizontal < 0 || horizontal > 1 || vertical < 0 || vertical > 1) return false;
  const worldX = viewport.centerX - viewport.worldWidth / 2 + horizontal * viewport.worldWidth;
  const worldY = viewport.centerY + viewport.worldHeight / 2 - vertical * viewport.worldHeight;
  const paddingFactor = currentState?.phase === "due" ? 0.02 : 0.01;
  const paddingX = viewport.worldWidth * paddingFactor;
  const paddingY = viewport.worldHeight * paddingFactor;
  const withinBounds = worldX >= bounds.offset.x - paddingX
    && worldX <= bounds.offset.x + bounds.size.x + paddingX
    && worldY >= bounds.offset.y - paddingY
    && worldY <= bounds.offset.y + bounds.size.y + paddingY;
  if (!withinBounds) return false;
  if (currentModel.hitPolygons?.length && !pointInHitPolygons(worldX, worldY, currentModel.hitPolygons)) return false;
  const pixelHit = renderedPixelIsOpaque(event, rect);
  return pixelHit === null ? true : pixelHit;
}

function updateMousePassthrough(event) {
  if (pointer) {
    setMousePassthrough(false);
    return;
  }
  setMousePassthrough(!isPointerOverPet(event));
}

function setMousePassthrough(ignored) {
  if (mouseEventsIgnored === ignored || !window.relaxEyes?.setIgnoreMouseEvents) return;
  mouseEventsIgnored = ignored;
  window.relaxEyes.setIgnoreMouseEvents(ignored);
}

function updateHover(event) {
  const hoverLocked = performance.now() < (currentModel?.hoverSuppressedUntil || 0)
    || Boolean(activeBehavior)
    || isAnimationBusy();
  const inside = isPointerOverPet(event);
  if (!inside) {
    hovered = false;
    return;
  }
  if (hovered || hoverLocked || pointer || currentState?.phase === "due"
    || currentState?.paused || hasWaitingCodexNotification()) return;
  hovered = true;
  const now = Date.now();
  if (now - lastHoverAt < HOVER_COOLDOWN_MS) return;
  lastHoverAt = now;
  triggerPetInteraction("hover", event);
}

canvas.addEventListener("pointerdown", beginPointer);
canvas.addEventListener("pointermove", movePointer);
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", () => {
  const cancelledPointer = pointer;
  if (pointer?.dueClickTimer) window.clearTimeout(pointer.dueClickTimer);
  if (pointer?.longPressTimer) window.clearTimeout(pointer.longPressTimer);
  if (cancelledPointer?.moved) {
    triggerPetInteraction("drag-end", cancelledPointer.region, { force: true });
  }
  pointer = null;
  hovered = false;
  window.relaxEyes.cancelDrag?.();
  setMousePassthrough(true);
});
canvas.addEventListener("pointerenter", (event) => {
  updateHover(event);
  updateMousePassthrough(event);
});
canvas.addEventListener("pointerleave", () => {
  if (!pointer) {
    hovered = false;
    setMousePassthrough(true);
  }
});
canvas.addEventListener("contextmenu", (event) => {
  if (!isPointerOverPet(event)) {
    setMousePassthrough(true);
    return;
  }
  event.preventDefault();
  window.relaxEyes.openContextMenu();
});
window.addEventListener("mousemove", updateMousePassthrough);

window.addEventListener("resize", resizeCanvas);
window.relaxEyes.onState(updateHud);
window.relaxEyes.onEvent(handleEvent);

Promise.all([
  window.relaxEyes.getState(),
  loadPetCatalog().catch((error) => {
    console.error(error);
    throw error;
  }),
  loadInteractionCatalog().catch((error) => {
    console.error(error);
    interactionCatalog = [];
    return [];
  }),
]).then(([state]) => {
  updateHud(state);
  return loadModel(state.model);
}).catch(showError);

renderFrame();
