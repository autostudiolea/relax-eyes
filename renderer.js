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

// All pets share the visible frame calibrated from 图图's F_ attachments.
const REFERENCE_MODEL_BOUNDS = Object.freeze({ width: 370, height: 418 });

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
let lastIdleAnimation = "";
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
const MAX_ENVELOPE_SAMPLES = 24;
const MAX_CAMERA_MULTIPLIER = 1.7;
const BASE_ACTION_NAMES = Object.freeze(["Relax", "Interact", "Move", "Sit", "Sleep", "Special"]);

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

function collectBounds(skeleton, focusPrefix) {
  if (focusPrefix) {
    const vertices = [];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let matched = false;
    for (const slot of skeleton.drawOrder) {
      const attachment = slot.getAttachment();
      const slotName = slot.data.name || "";
      const attachmentName = attachment?.name || "";
      if (!slotName.startsWith(focusPrefix) && !attachmentName.startsWith(focusPrefix)) continue;
      if (attachment instanceof spine.RegionAttachment) {
        vertices.length = 8;
        attachment.computeWorldVertices(slot.bone, vertices, 0, 2);
      } else if (attachment instanceof spine.MeshAttachment) {
        vertices.length = attachment.worldVerticesLength;
        attachment.computeWorldVertices(slot, 0, attachment.worldVerticesLength, vertices, 0, 2);
      } else {
        continue;
      }
      matched = true;
      for (let index = 0; index < vertices.length; index += 2) {
        minX = Math.min(minX, vertices[index]);
        minY = Math.min(minY, vertices[index + 1]);
        maxX = Math.max(maxX, vertices[index]);
        maxY = Math.max(maxY, vertices[index + 1]);
      }
    }
    if (matched && maxX > minX && maxY > minY) {
      return {
        offset: new spine.Vector2(minX, minY),
        size: new spine.Vector2(maxX - minX, maxY - minY),
      };
    }
  }
  const offset = new spine.Vector2();
  const size = new spine.Vector2();
  skeleton.getBounds(offset, size, []);
  if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || size.x <= 0 || size.y <= 0) {
    throw new Error("模型没有有效的可见边界");
  }
  return { offset, size };
}

function collectHitPolygons(skeleton, focusPrefix) {
  const polygons = [];
  for (const slot of skeleton.drawOrder) {
    const attachment = slot.getAttachment();
    const slotName = slot.data.name || "";
    const attachmentName = attachment?.name || "";
    if (focusPrefix && !slotName.startsWith(focusPrefix) && !attachmentName.startsWith(focusPrefix)) continue;
    if (attachment instanceof spine.RegionAttachment) {
      const vertices = new Array(8);
      attachment.computeWorldVertices(slot.bone, vertices, 0, 2);
      polygons.push({ vertices, indices: [0, 1, 2, 0, 2, 3] });
    } else if (attachment instanceof spine.MeshAttachment) {
      const vertices = new Array(attachment.worldVerticesLength);
      attachment.computeWorldVertices(slot, 0, attachment.worldVerticesLength, vertices, 0, 2);
      const indices = Array.from(attachment.triangles || []);
      if (vertices.length >= 6 && indices.length >= 3) polygons.push({ vertices, indices });
    }
  }
  return polygons;
}

function calculateBounds(skeleton, focusPrefix) {
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform();
  return collectBounds(skeleton, focusPrefix);
}

function mergeBounds(target, bounds) {
  const minX = bounds.offset.x;
  const minY = bounds.offset.y;
  const maxX = minX + bounds.size.x;
  const maxY = minY + bounds.size.y;
  target.minX = Math.min(target.minX, minX);
  target.minY = Math.min(target.minY, minY);
  target.maxX = Math.max(target.maxX, maxX);
  target.maxY = Math.max(target.maxY, maxY);
}

function boundsFromExtents(extents) {
  if (!Number.isFinite(extents.minX) || !Number.isFinite(extents.maxX)
    || extents.maxX <= extents.minX || extents.maxY <= extents.minY) {
    throw new Error("模型没有有效的动画边界");
  }
  return {
    offset: new spine.Vector2(extents.minX, extents.minY),
    size: new spine.Vector2(extents.maxX - extents.minX, extents.maxY - extents.minY),
  };
}

function calculateAnimationEnvelope(skeleton, focusPrefix, selectedAnimations = skeleton.data.animations) {
  const extents = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  const animations = selectedAnimations || [];
  for (const animation of animations) {
    const duration = Math.max(0, Number(animation.duration) || 0);
    const sampleCount = duration > 0
      ? Math.min(MAX_ENVELOPE_SAMPLES, Math.max(2, Math.ceil(duration * 6)))
      : 1;
    for (let index = 0; index < sampleCount; index += 1) {
      const time = sampleCount === 1 ? 0 : duration * index / (sampleCount - 1);
      skeleton.setToSetupPose();
      animation.apply(
        skeleton,
        0,
        time,
        false,
        [],
        1,
        spine.MixBlend.setup,
        spine.MixDirection.mixIn,
      );
      skeleton.updateWorldTransform();
      mergeBounds(extents, collectBounds(skeleton, focusPrefix));
    }
  }
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform();
  return boundsFromExtents(extents);
}

function calculateTypicalAnimationBounds(skeleton, focusPrefix, animation) {
  const duration = Math.max(0, Number(animation?.duration) || 0);
  const sampleCount = duration > 0
    ? Math.min(MAX_ENVELOPE_SAMPLES, Math.max(4, Math.ceil(duration * 6)))
    : 1;
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const time = sampleCount === 1 ? 0 : duration * index / (sampleCount - 1);
    skeleton.setToSetupPose();
    animation.apply(
      skeleton,
      0,
      time,
      false,
      [],
      1,
      spine.MixBlend.setup,
      spine.MixDirection.mixIn,
    );
    skeleton.updateWorldTransform();
    samples.push(collectBounds(skeleton, focusPrefix));
  }
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform();
  if (!samples.length) throw new Error("默认动作没有有效边界");
  samples.sort((left, right) => {
    const leftArea = left.size.x * left.size.y;
    const rightArea = right.size.x * right.size.y;
    return leftArea - rightArea;
  });
  return samples[Math.floor(samples.length * 0.55)];
}

function transformBounds(bounds, root, scale) {
  const rootX = Number(root?.x) || 0;
  const rootY = Number(root?.y) || 0;
  const x1 = rootX + (bounds.offset.x - rootX) * scale;
  const y1 = rootY + (bounds.offset.y - rootY) * scale;
  const x2 = rootX + (bounds.offset.x + bounds.size.x - rootX) * scale;
  const y2 = rootY + (bounds.offset.y + bounds.size.y - rootY) * scale;
  return {
    offset: new spine.Vector2(Math.min(x1, x2), Math.min(y1, y2)),
    size: new spine.Vector2(Math.abs(x2 - x1), Math.abs(y2 - y1)),
  };
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

function waitForAssets(assetManager) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const poll = () => {
      if (assetManager.hasErrors()) {
        reject(new Error(Object.values(assetManager.getErrors()).join("\n")));
        return;
      }
      if (assetManager.isLoadingComplete()) {
        resolve();
        return;
      }
      if (performance.now() - startedAt > 15000) {
        reject(new Error("模型资源加载超时"));
        return;
      }
      window.setTimeout(poll, 30);
    };
    poll();
  });
}

async function loadInteractionCatalog() {
  const response = await fetch("/interactions.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`互动动作目录加载失败: ${response.status}`);
  const actions = await response.json();
  interactionCatalog = Array.isArray(actions) ? actions : [];
  return interactionCatalog;
}

async function loadPetCatalog() {
  const response = await fetch("/pets.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`宠物目录加载失败: ${response.status}`);
  const pets = await response.json();
  petCatalog = Array.isArray(pets)
    ? pets.filter((pet) => pet && typeof pet.id === "string" && pet.skeleton && pet.atlas)
    : [];
  MODELS = Object.fromEntries(petCatalog.map((pet) => [pet.id, pet]));
  if (!MODELS.tutu) {
    petCatalog.unshift(FALLBACK_MODEL);
    MODELS.tutu = FALLBACK_MODEL;
  }
  return petCatalog;
}

function resolveAnimationName(name) {
  if (!currentModel || !name) return null;
  const aliases = currentModel.definition?.animationAliases || {};
  const candidates = [aliases[name], name].filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
  return candidates.find((candidate) => currentModel.skeleton.data.findAnimation(candidate)) || null;
}

function findAnimation(name, fallback = "Relax") {
  return resolveAnimationName(name) || resolveAnimationName(fallback) || currentModel?.skeleton.data.animations[0]?.name;
}

function hasAnimation(name) {
  return Boolean(resolveAnimationName(name));
}

function availableAnimationNames(skeletonData, model) {
  const aliases = model.animationAliases || {};
  const actualNames = new Set();
  const names = [];
  for (const name of BASE_ACTION_NAMES) {
    const actualName = aliases[name] || name;
    if (!skeletonData.findAnimation(actualName) || actualNames.has(actualName)) continue;
    actualNames.add(actualName);
    names.push(name);
  }
  return names;
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
    const idle = findAnimation("Relax", resolvedName);
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
  const idle = findAnimation("Relax", steps[steps.length - 1].name);
  if (idle) currentModel.state.addAnimation(0, idle, true, 0);
  activeBehavior = withEffect
    ? {
      effect: createBehaviorEffect(action),
      startedAt: performance.now(),
      endsAt: performance.now() + Math.max(900, estimateActionDuration(steps) * 1000),
    }
    : null;
  lastIdleAnimation = action.id;
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
  if (!entry?.animation || entry.animation.name === "Relax") return false;
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

  if (!interactionCatalog.length) {
    scheduleIdleActivity(2500);
    return;
  }
  let choices = interactionCatalog.filter((action) => action.id !== lastIdleAnimation);
  if (choices.length === 0) choices = interactionCatalog;
  if (choices.length > 0) {
    const action = choices[Math.floor(Math.random() * choices.length)];
    lastIdleAnimation = action.id;
    playInteractionAction(action.id, false);
  }
  scheduleIdleActivity();
}

async function loadModel(modelId, animationName) {
  const model = MODELS[modelId] || MODELS.tutu || petCatalog[0] || FALLBACK_MODEL;
  if (idleTimer) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
  showLoading(`正在加载 ${model.label}`);
  try {
    removeReminderMotion();
    reminderMotion = null;
    clearBehavior();
    initializeRenderer();
    if (currentModel?.assets) currentModel.assets.dispose();
    const assetManager = new spine.webgl.AssetManager(gl);
    const skeletonIsJson = model.skeletonFormat === "json" || model.skeleton.toLowerCase().endsWith(".json");
    if (skeletonIsJson) assetManager.loadText(model.skeleton);
    else assetManager.loadBinary(model.skeleton);
    assetManager.loadTextureAtlas(model.atlas);
    await waitForAssets(assetManager);

    const atlas = assetManager.get(model.atlas);
    const loader = new spine.AtlasAttachmentLoader(atlas);
    let skeletonData;
    if (skeletonIsJson) {
      const skeletonJson = new spine.SkeletonJson(loader);
      skeletonJson.scale = 1;
      skeletonData = skeletonJson.readSkeletonData(assetManager.get(model.skeleton));
    } else {
      const skeletonBinary = new spine.SkeletonBinary(loader);
      skeletonBinary.scale = 1;
      skeletonData = skeletonBinary.readSkeletonData(assetManager.get(model.skeleton));
    }
    const skeleton = new spine.Skeleton(skeletonData);
    const focusPrefix = model.focusPrefix || "F_";
    const setupBounds = calculateBounds(skeleton, focusPrefix);
    const initialAnimationName = model.animationAliases?.[model.initialAnimation] || model.initialAnimation;
    const initialAnimation = skeletonData.findAnimation(initialAnimationName) || skeletonData.animations[0];
    const animationStateData = new spine.AnimationStateData(skeleton.data);
    animationStateData.defaultMix = 0.18;
    const animationState = new spine.AnimationState(animationStateData);
    let bounds = setupBounds;
    if (initialAnimation) {
      try {
        bounds = calculateTypicalAnimationBounds(skeleton, focusPrefix, initialAnimation);
      } catch (error) {
        console.warn(`无法计算 ${model.label} 的默认动作边界，使用设置姿态:`, error);
      }
    }
    let animationEnvelope = bounds;
    try {
      animationEnvelope = calculateAnimationEnvelope(skeleton);
    } catch (error) {
      console.warn(`无法计算 ${model.label} 的完整动画边界，使用基础边界:`, error);
    }
    const root = skeleton.bones[0];
    const uniformScale = Math.min(
      REFERENCE_MODEL_BOUNDS.width / bounds.size.x,
      REFERENCE_MODEL_BOUNDS.height / bounds.size.y,
    );
    const cameraBounds = transformBounds(animationEnvelope, root, uniformScale);
    const hitBounds = transformBounds(bounds, root, uniformScale);
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
    currentModel = {
      id: model.id,
      definition: model,
      assets: assetManager,
      skeleton,
      state: animationState,
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
    lastContentInsetsReport = null;
    appliedModelTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    window.relaxEyes.setAvailableAnimations(model.id, availableAnimationNames(skeletonData, model));
    lastIdleAnimation = "";
    playAnimation(animationName || model.initialAnimation, model.initialLoop);
    setMousePassthrough(true);
    hideLoading();
    errorPanel.hidden = true;
  } catch (error) {
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
    currentModel.hitBounds = collectBounds(currentModel.skeleton, currentModel.definition.focusPrefix || "F_");
    currentModel.hitPolygons = collectHitPolygons(currentModel.skeleton, currentModel.definition.focusPrefix || "F_");
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
    }
  } catch {
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
  } else if (!finishedPointer.dueClickConfirmed) {
    window.relaxEyes.petClick();
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
