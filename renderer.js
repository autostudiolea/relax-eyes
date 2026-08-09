const FALLBACK_MODEL = {
  id: "tutu",
  label: "图图",
  skeleton: "/assets/tutu/tutu.skel",
  atlas: "/assets/tutu/tutu.atlas",
  initialAnimation: "Relax",
  initialLoop: true,
  fitScale: 0.68,
  focusPrefix: "F_",
  animationAliases: {
    Relax: "Relax",
    Idle: "Relax",
    Interact: "Interact",
    Move: "Move",
    Sit: "Sit",
    Sleep: "Sleep",
    Special: "Interact",
    Start: "Relax",
  },
};

let MODELS = {};

const EFFECT_TYPES = [
  "bounce", "bob", "sway", "pulse", "hop", "shake", "nod", "wiggle",
  "stretch", "squash", "float", "step", "lean", "tremble",
];

// All pets share the visible frame calibrated from tutu's F_ attachments.
const REFERENCE_MODEL_BOUNDS = window.RelaxEyesSpinePetAdapter.REFERENCE_MODEL_BOUNDS;

const canvas = document.getElementById("pet-canvas");
const loading = document.getElementById("loading");
const errorPanel = document.getElementById("error");
const reminder = document.getElementById("reminder");
const reminderTitle = document.querySelector("#reminder strong");
const reminderBody = document.querySelector("#reminder span");

let gl = null;
let shader = null;
let batcher = null;
let skeletonRenderer = null;
let mvp = null;
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
let hovered = false;
let lastHoverAt = 0;
let lastContentInsetsReport = null;
let mouseEventsIgnored = null;
let appliedBehaviorEffect = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
let appliedModelTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

const IDLE_DELAY_MIN_MS = 5500;
const IDLE_DELAY_MAX_MS = 12000;
const REMINDER_RUN_DURATION_MS = 9000;
const HOVER_COOLDOWN_MS = 1800;
const DUE_CLICK_GRACE_MS = 220;
const MAX_CAMERA_MULTIPLIER = 1.7;

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
  if (!MODELS.tutu) {
    petCatalog.unshift(FALLBACK_MODEL);
    MODELS.tutu = FALLBACK_MODEL;
  }
  if (catalog.source !== "pet-packs") console.warn("Using legacy pets.json catalog:", catalog.catalogError);
  return petCatalog;
}

function resolveAnimationName(name) {
  return currentModel?.adapter?.resolveAnimationName(name) || null;
}

function findAnimation(name, fallback = "Relax") {
  return resolveAnimationName(name) || resolveAnimationName(fallback) || currentModel?.skeleton.data.animations[0]?.name;
}

function hasAnimation(name) {
  return Boolean(resolveAnimationName(name));
}

function buildIdleAnimationPool(model, rawAnimations, idleAnimationName) {
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

function playIdleAnimationSequence() {
  if (!currentModel) return;
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
    return;
  }

  clearBehavior();
  currentModel.state.setAnimation(0, names[0], false);
  for (const name of names.slice(1)) currentModel.state.addAnimation(0, name, false, 0.08);
  const idle = currentModel.idleAnimationName || findAnimation("Relax", names[names.length - 1]);
  if (idle) currentModel.state.addAnimation(0, idle, true, 0.05);
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

function applyReminderMotion(now) {
  removeReminderMotion();
  if (!reminderMotion) return;
  const progress = (now - reminderMotion.startedAt) / (reminderMotion.endsAt - reminderMotion.startedAt);
  if (progress >= 1) return;
  const root = currentModel?.skeleton.bones[0];
  if (!root) return;
  const runWave = Math.sin(progress * Math.PI * 4.2);
  const hopWave = Math.max(0, Math.sin(progress * Math.PI * 8.4));
  appliedReminderMotion = {
    x: runWave * REFERENCE_MODEL_BOUNDS.width * 0.25,
    y: hopWave * REFERENCE_MODEL_BOUNDS.height * 0.025,
  };
  root.x += appliedReminderMotion.x;
  root.y += appliedReminderMotion.y;
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
  root.x += currentModel.normalization.x;
  root.y += currentModel.normalization.y;
  root.scaleX *= currentModel.normalization.scaleX;
  root.scaleY *= currentModel.normalization.scaleY;
  appliedModelTransform = {
    x: currentModel.normalization.x,
    y: currentModel.normalization.y,
    scaleX: currentModel.normalization.scaleX,
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

function expandActionSteps(action) {
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
  return steps;
}

function estimateActionDuration(steps) {
  return steps.reduce((total, step) => {
    const animation = currentModel.skeleton.data.findAnimation(step.name);
    const duration = Number(animation?.duration);
    return total + (Number.isFinite(duration) ? duration / step.speed : 0.8) + step.delay;
  }, 0);
}

function playAnimation(name, loop = false) {
  if (!currentModel) return;
  clearBehavior();
  const resolvedName = findAnimation(name);
  if (!resolvedName) return;
  currentModel.state.setAnimation(0, resolvedName, loop);
  if (!loop) {
    const idle = currentModel.idleAnimationName || findAnimation("Relax", resolvedName);
    currentModel.state.addAnimation(0, idle, true, 0);
  }
  scheduleIdleActivity();
}

function playInteractionAction(actionId, withEffect = true) {
  if (!currentModel) return;
  const action = typeof actionId === "string"
    ? interactionCatalog.find((candidate) => candidate.id === actionId)
    : actionId;
  if (!action) return;
  const steps = expandActionSteps(action);
  if (!steps.length) {
    playAnimation("Relax", true);
    return;
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
  activeBehavior = withEffect
    ? {
      effect: createBehaviorEffect(action),
      startedAt: performance.now(),
      endsAt: performance.now() + Math.max(900, estimateActionDuration(steps) * 1000),
    }
    : null;
  scheduleIdleActivity();
}

function playRandomInteraction(ids = null) {
  const candidates = interactionCatalog.filter((action) => !ids || ids.includes(action.id));
  if (!candidates.length) {
    playAnimation("Interact", false);
    return;
  }
  playInteractionAction(candidates[Math.floor(Math.random() * candidates.length)].id);
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
  if (!currentModel || pointer || currentState?.phase === "due" || currentState?.paused || !reminder.hidden) {
    scheduleIdleActivity(2500);
    return;
  }
  if (isAnimationBusy()) {
    scheduleIdleActivity(1800);
    return;
  }

  playIdleAnimationSequence();
  scheduleIdleActivity();
}

async function loadModel(modelId, animationName) {
  const model = MODELS[modelId] || MODELS.tutu || petCatalog[0] || FALLBACK_MODEL;
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
    adapter = new window.RelaxEyesSpinePetAdapter(model, gl);
    const loaded = await adapter.load();
    const {
      assetManager,
      skeleton,
      rawAnimations,
      initialAnimationName,
      bounds,
      animationEnvelope,
    } = loaded;
    const animationStateData = new spine.AnimationStateData(skeleton.data);
    animationStateData.defaultMix = 0.18;
    const animationState = new spine.AnimationState(animationStateData);
    const root = skeleton.bones[0];
    const uniformScale = Math.min(
      REFERENCE_MODEL_BOUNDS.width / bounds.size.x,
      REFERENCE_MODEL_BOUNDS.height / bounds.size.y,
    );
    const cameraBounds = adapter.transformBounds(animationEnvelope, root, uniformScale);
    const hitBounds = adapter.transformBounds(bounds, root, uniformScale);
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
      definition: model,
      adapter,
      assets: assetManager,
      skeleton,
      state: animationState,
      rawAnimations,
      idleAnimationName: initialAnimationName || rawAnimations[0] || null,
      idleAnimations: buildIdleAnimationPool(model, rawAnimations, initialAnimationName),
      recentIdleAnimations: [],
      bounds,
      displayBounds: null,
      contentBounds: hitBounds,
      hitBounds,
      hitPolygons: [],
      cameraBounds,
      cameraCenter: {
        x: bodyCenter.x,
        y: bodyCenter.y,
      },
      cameraSize,
      normalization: {
        x: 0,
        y: 0,
        scaleX: uniformScale,
        scaleY: uniformScale,
      },
      fitScale: Number.isFinite(Number(model.fitScale)) ? Number(model.fitScale) : 0.68,
    };
    if (previousModel?.adapter) previousModel.adapter.dispose();
    currentModel = nextModel;
    lastContentInsetsReport = null;
    appliedModelTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    window.relaxEyes.setAvailableAnimations(model.id, rawAnimations);
    playAnimation(animationName || currentModel.idleAnimationName || model.initialAnimation, model.initialLoop);
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
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
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
  applyModelTransform();
  applyBehaviorEffect(performance.now());
  applyReminderMotion(performance.now());
  currentModel.skeleton.updateWorldTransform();
  const displayOffset = new spine.Vector2();
  const displaySize = new spine.Vector2();
  currentModel.skeleton.getBounds(displayOffset, displaySize, []);
  if (Number.isFinite(displaySize.x) && Number.isFinite(displaySize.y) && displaySize.x > 0 && displaySize.y > 0) {
    currentModel.displayBounds = { offset: displayOffset, size: displaySize };
  }
  try {
    currentModel.hitBounds = currentModel.adapter.collectBounds(currentModel.skeleton);
    currentModel.hitPolygons = currentModel.adapter.collectHitPolygons(currentModel.skeleton);
  } catch {
    currentModel.hitBounds = currentModel.displayBounds || currentModel.hitBounds;
    currentModel.hitPolygons = [];
  }
  resizeCanvas();
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

function updateHud(state) {
  currentState = state;
  const seconds = Math.round(Number(state.restDurationMs || 20000) / 1000);
  const body = (state.reminderBody || "看向远处 {seconds} 秒，或者点击宠物确认已经休息。")
    .replaceAll("{seconds}", String(seconds))
    .replaceAll("{restSeconds}", String(seconds));
  reminderTitle.textContent = state.reminderTitle || "该放松一下眼睛了";
  reminderBody.textContent = body;
  const due = state.phase === "due";
  reminder.hidden = !due;
  document.body.classList.toggle("is-reminding", due);
}

function playReminderSound() {
  try {
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
      gain.gain.exponentialRampToValueAtTime(0.18, noteStart + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.3);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + 0.32);
    });
  } catch {
    // Audio is a convenience; the system notification and animation remain available.
  }
}

function startReminderMotion() {
  if (!currentModel) return;
  const motion = {
    startedAt: performance.now(),
    endsAt: performance.now() + REMINDER_RUN_DURATION_MS,
  };
  reminderMotion = motion;
  playReminderSound();
  playAnimation("Move", true);
  window.setTimeout(() => {
    if (reminderMotion !== motion) return;
    reminderMotion = null;
    playAnimation("Relax", true);
  }, REMINDER_RUN_DURATION_MS);
}

function handleEvent(event) {
  if (event.type === "play-action") {
    playInteractionAction(event.id);
  } else if (event.type === "model-change") {
    loadModel(event.model);
  } else if (event.type === "pet-click") {
    playRandomInteraction(["greet", "enthusiastic-greet", "gentle-greet", "sit-nod", "playful", "check-in", "tiny-response", "shy"]);
  } else if (event.type === "play-animation") {
    playAnimation(event.name, false);
  } else if (event.type === "reminder-due") {
    reminder.hidden = false;
    document.body.classList.add("is-reminding");
    startReminderMotion();
  } else if (event.type === "timer-reset") {
    removeReminderMotion();
    reminderMotion = null;
    reminder.hidden = true;
    document.body.classList.remove("is-reminding");
    scheduleIdleActivity(2500);
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
    moved: false,
    dragAnimationStarted: false,
    dueClickConfirmed: false,
    dueClickTimer: null,
    pointerId: event.pointerId,
  };
  pointer = nextPointer;
  canvas.setPointerCapture?.(event.pointerId);
  if (currentState?.phase === "due") {
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
  if (pointer.moved && pointer.dueClickTimer) {
    window.clearTimeout(pointer.dueClickTimer);
    pointer.dueClickTimer = null;
  }
  if (pointer.moved) {
    if (!pointer.dragAnimationStarted) {
      pointer.dragAnimationStarted = true;
      // Move animations in some source models contain scale keys; dragging itself is the interaction.
      playAnimation("Relax", true);
    }
    window.relaxEyes.moveWindow(pointer.originX + dx, pointer.originY + dy);
  }
}

function endPointer(event) {
  if (!pointer) return;
  const finishedPointer = pointer;
  pointer = null;
  if (finishedPointer.dueClickTimer) window.clearTimeout(finishedPointer.dueClickTimer);
  if (finishedPointer.moved) {
    const dx = event.screenX - finishedPointer.startX;
    const dy = event.screenY - finishedPointer.startY;
    if (Number.isFinite(finishedPointer.originX)) {
      window.relaxEyes.endDrag(finishedPointer.originX + dx, finishedPointer.originY + dy);
    }
    playAnimation("Relax", true);
  } else {
    if (!finishedPointer.dueClickConfirmed) window.relaxEyes.petClick();
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
  const inside = isPointerOverPet(event);
  if (!inside) {
    hovered = false;
    return;
  }
  if (hovered || pointer || currentState?.phase === "due" || currentState?.paused) return;
  hovered = true;
  const now = Date.now();
  if (now - lastHoverAt < HOVER_COOLDOWN_MS) return;
  lastHoverAt = now;
  playRandomInteraction(["gentle-greet", "tiny-response", "shy", "sit-nod", "check-in"]);
}

canvas.addEventListener("pointerdown", beginPointer);
canvas.addEventListener("pointermove", movePointer);
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", () => {
  removeReminderMotion();
  if (pointer?.dueClickTimer) window.clearTimeout(pointer.dueClickTimer);
  if (pointer?.moved) playAnimation("Relax", true);
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
    petCatalog = [FALLBACK_MODEL];
    MODELS = { tutu: FALLBACK_MODEL };
    return petCatalog;
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
