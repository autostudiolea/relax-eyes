const range = document.getElementById("size-range");
const output = document.getElementById("size-value");
const intervalInput = document.getElementById("interval-minutes");
const restInput = document.getElementById("rest-seconds");
const titleInput = document.getElementById("reminder-title");
const bodyInput = document.getElementById("reminder-body");
const eyeBreakEnabled = document.getElementById("eye-break-enabled");
const reminderAccent = document.getElementById("reminder-accent");
const weeklyReportEnabled = document.getElementById("weekly-report-enabled");
const weeklyReportWeekday = document.getElementById("weekly-report-weekday");
const weeklyReportTime = document.getElementById("weekly-report-time");
const weeklyReportTitle = document.getElementById("weekly-report-title");
const weeklyReportBody = document.getElementById("weekly-report-body");
const weeklyReportAccent = document.getElementById("weekly-report-accent");
const codexEnabled = document.getElementById("codex-enabled");
const soundVolume = document.getElementById("sound-volume");
const soundVolumeValue = document.getElementById("sound-volume-value");
const codexBubbleScale = document.getElementById("codex-bubble-scale");
const codexBubbleScaleValue = document.getElementById("codex-bubble-scale-value");
const codexCompletedAccent = document.getElementById("codex-completed-accent");
const codexWaitingAccent = document.getElementById("codex-waiting-accent");
const codexFailedAccent = document.getElementById("codex-failed-accent");
const codexStartedAccent = document.getElementById("codex-started-accent");
const resetButton = document.getElementById("reset-settings");
const saveButton = document.getElementById("save-settings");
const closeButton = document.getElementById("close-settings");
const saveStatus = document.getElementById("save-status");
const unsavedDialog = document.getElementById("unsaved-dialog");
const continueEditingButton = document.getElementById("continue-editing");
const discardButton = document.getElementById("discard-settings");
const petVisibilityList = document.getElementById("pet-visibility-list");
const petVisibilityStatus = document.getElementById("pet-visibility-status");

const DEFAULTS = {
  displayScale: 0.35,
  intervalMinutes: 20,
  restSeconds: 20,
  reminderTitle: "该放松一下眼睛了",
  reminderBody: "看向远处 {seconds} 秒，或者点击宠物确认已经休息。",
  eyeBreakEnabled: true,
  reminderAccent: "#ff9c60",
  weeklyReportEnabled: true,
  weeklyReportWeekday: 5,
  weeklyReportTime: "15:00",
  weeklyReportTitle: "该写周报了",
  weeklyReportBody: "花几分钟回顾本周完成的工作和下周计划。",
  weeklyReportAccent: "#e5484d",
  codexEnabled: true,
  soundVolume: 0.65,
  codexBubbleScale: 1,
  codexCompletedAccent: "#45d483",
  codexWaitingAccent: "#ffd166",
  codexFailedAccent: "#ff6b6b",
  codexStartedAccent: "#71b7ff",
};

let savedDraft = null;
let dirty = false;
let saving = false;
let availablePets = [];
let visiblePetsDraft = [];
let currentModelId = "";
let previewCatalogPromise = null;
let previewRenderer = null;
let previewObserver = null;
const previewInFlight = new Set();
const previewImageCache = new Map();

function validAccent(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""))
    ? String(value).toLowerCase()
    : fallback;
}

function updateValueLabels() {
  output.textContent = `${range.value}%`;
  soundVolumeValue.textContent = `${soundVolume.value}%`;
  codexBubbleScaleValue.textContent = `${codexBubbleScale.value}%`;
}

function normalizeVisiblePets(value) {
  const allIds = availablePets.map((pet) => pet.id);
  if (!allIds.length) return Array.isArray(value) ? [...value] : [];
  const requested = Array.isArray(value) && value.length
    ? new Set(value)
    : new Set(allIds);
  return allIds.filter((id) => requested.has(id));
}

function ensurePreviewObserver() {
  if (previewObserver || typeof IntersectionObserver !== "function") return;
  previewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const petId = entry.target?.dataset?.petPreview;
      if (petId) void renderPreviewForPet(petId);
    }
  }, { root: null, rootMargin: "160px" });
}

function renderPetVisibility() {
  if (!petVisibilityList || !petVisibilityStatus) return;
  ensurePreviewObserver();
  previewObserver?.disconnect();
  petVisibilityList.replaceChildren();
  if (!availablePets.length) {
    petVisibilityStatus.textContent = "正在加载角色目录...";
    return;
  }

  const selected = new Set(visiblePetsDraft);
  const selectedCount = selected.size;
  const groups = [
    { key: "spine", label: "Spine", pets: availablePets.filter((pet) => pet.engine === "spine") },
    { key: "codex", label: "Codex", pets: availablePets.filter((pet) => pet.engine === "codex-webp") },
    { key: "other", label: "Other", pets: availablePets.filter((pet) => !["spine", "codex-webp"].includes(pet.engine)) },
  ].filter((group) => group.pets.length);
  for (const group of groups) {
    const section = document.createElement("section");
    section.className = `pet-group pet-group-${group.key}`;
    const heading = document.createElement("h3");
    heading.className = "pet-group-title";
    heading.textContent = group.label;
    const list = document.createElement("div");
    list.className = "pet-group-list";
    section.append(heading, list);
    petVisibilityList.append(section);
    group.pets.forEach((pet) => {
    const checked = selected.has(pet.id);
    const card = document.createElement("label");
    card.className = `pet-card${checked ? " selected" : ""}`;

    const preview = document.createElement("img");
    preview.className = "pet-preview";
    preview.alt = `${pet.label || pet.id} 静态预览`;
    preview.dataset.petPreview = pet.id;
    const cachedPreview = previewImageCache.get(pet.id);
    const staticFallbackAllowed = !["spine", "codex-webp", "sprite"].includes(pet.engine);
    if (cachedPreview || (staticFallbackAllowed && pet.preview)) {
      preview.src = cachedPreview || pet.preview;
    }
    preview.addEventListener("error", () => {
      preview.removeAttribute("src");
      preview.alt = `${pet.label || pet.id} 预览不可用`;
    }, { once: true });

    const copy = document.createElement("span");
    copy.className = "pet-card-copy";
    const name = document.createElement("span");
    name.className = "pet-card-name";
    name.textContent = pet.label || pet.id;
    const id = document.createElement("span");
    id.className = "pet-card-id";
    id.textContent = pet.id;
    copy.append(name, id);
    if (pet.id === currentModelId) {
      const current = document.createElement("span");
      current.className = "pet-card-current";
      current.textContent = "当前使用";
      copy.append(current);
    }

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.ariaLabel = `在切换菜单中显示 ${pet.label || pet.id}`;
    checkbox.disabled = pet.id === currentModelId || (checked && selectedCount <= 1);
    checkbox.addEventListener("change", () => {
      const next = new Set(visiblePetsDraft);
      if (checkbox.checked) next.add(pet.id);
      else next.delete(pet.id);
      if (!next.size) {
        checkbox.checked = true;
        return;
      }
      visiblePetsDraft = availablePets
        .filter((item) => next.has(item.id))
        .map((item) => item.id);
      renderPetVisibility();
      markDraftChanged();
    });

    card.append(preview, copy, checkbox);
    list.append(card);
    previewObserver?.observe(preview);
    });
  }
  petVisibilityStatus.textContent = `已选择 ${selectedCount} / ${availablePets.length} 个角色`;
}

function previewImageFor(id) {
  return [...document.querySelectorAll("img[data-pet-preview]")]
    .find((image) => image.dataset.petPreview === id);
}

async function loadPreviewModels() {
  if (!previewCatalogPromise) previewCatalogPromise = window.RelaxEyesPetCatalog.load();
  const catalog = await previewCatalogPromise;
  return new Map((catalog.pets || []).map((pet) => [pet.id, pet]));
}

async function renderPreviewForPet(petId) {
  if (previewImageCache.has(petId) || previewInFlight.has(petId)) return;
  previewInFlight.add(petId);
  try {
    const models = await loadPreviewModels();
    const model = models.get(petId);
    if (!model || !["spine", "codex-webp"].includes(model.engine)) return;
    if (model.engine === "spine" && !previewRenderer) {
      previewRenderer = createPreviewRenderer();
    }
    if (model.engine === "spine" && !previewRenderer) return;
    const dataUrl = model.engine === "codex-webp"
      ? await renderCodexPreview(model)
      : await renderSpinePreview(model, previewRenderer);
    previewImageCache.set(petId, dataUrl);
    const image = previewImageFor(petId);
    if (image) image.src = dataUrl;
  } catch (error) {
    console.warn(`Could not render preview for ${petId}:`, error);
  } finally {
    previewInFlight.delete(petId);
  }
}

function startVisiblePreviews() {
  ensurePreviewObserver();
  if (previewObserver) return;
  for (const pet of availablePets) void renderPreviewForPet(pet.id);
}

function createPreviewRenderer() {
  if (!window.spine?.webgl || !window.RelaxEyesSpinePetAdapter) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:256px;height:256px;pointer-events:none";
  document.body.append(canvas);
  const gl = canvas.getContext("webgl", {
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
  if (!gl) {
    canvas.remove();
    return null;
  }
  gl.enable(gl.BLEND);
  return {
    canvas,
    gl,
    shader: window.spine.webgl.Shader.newTwoColoredTextured(gl),
    batcher: new window.spine.webgl.PolygonBatcher(gl),
    skeletonRenderer: new window.spine.webgl.SkeletonRenderer(gl),
    mvp: new window.spine.webgl.Matrix4(),
  };
}

async function renderSpinePreview(model, renderer) {
  const adapter = new window.RelaxEyesSpinePetAdapter(model, renderer.gl);
  try {
    const loaded = await adapter.load();
    const skeleton = loaded.skeleton;
    const root = skeleton.bones[0];
    const initialAnimation = loaded.initialAnimation;
    skeleton.setToSetupPose();
    if (initialAnimation) {
      initialAnimation.apply(
        skeleton,
        0,
        0,
        false,
        [],
        1,
        window.spine.MixBlend.setup,
        window.spine.MixDirection.mixIn,
      );
    }
    skeleton.updateWorldTransform();

    const baseScale = Math.min(
      370 / Math.max(1, loaded.bounds.size.x),
      418 / Math.max(1, loaded.bounds.size.y),
    );
    const calibration = model.calibration || {};
    root.x += Number(calibration.offsetX) || 0;
    root.y += Number(calibration.offsetY) || 0;
    root.scaleX *= baseScale * (Number(calibration.scaleX) || 1);
    root.scaleY *= baseScale * (Number(calibration.scaleY) || 1);
    skeleton.updateWorldTransform();

    const bounds = adapter.collectBounds(skeleton);
    const padding = 20;
    const viewScale = Math.min(
      (renderer.canvas.width - padding * 2) / Math.max(1, bounds.size.x),
      (renderer.canvas.height - padding * 2) / Math.max(1, bounds.size.y),
    );
    const viewWidth = renderer.canvas.width / viewScale;
    const viewHeight = renderer.canvas.height / viewScale;
    const centerX = bounds.offset.x + bounds.size.x / 2;
    const centerY = bounds.offset.y + bounds.size.y / 2;
    renderer.mvp.ortho2d(
      centerX - viewWidth / 2,
      centerY - viewHeight / 2,
      viewWidth,
      viewHeight,
    );

    const { gl } = renderer;
    gl.viewport(0, 0, renderer.canvas.width, renderer.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.shader.bind();
    renderer.shader.setUniformi(window.spine.webgl.Shader.SAMPLER, 0);
    renderer.shader.setUniform4x4f(window.spine.webgl.Shader.MVP_MATRIX, renderer.mvp.values);
    renderer.batcher.begin(renderer.shader);
    renderer.skeletonRenderer.premultipliedAlpha = false;
    renderer.skeletonRenderer.draw(renderer.batcher, skeleton);
    renderer.batcher.end();
    renderer.shader.unbind();
    gl.flush();
    return renderer.canvas.toDataURL("image/png");
  } finally {
    adapter.dispose();
  }
}

async function renderCodexPreview(model) {
  if (!window.RelaxEyesCodexPetFormat) throw new Error("Codex preview format is unavailable");
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create Codex preview canvas");
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error(`Could not load Codex preview for ${model.id}`));
    image.src = model.spritesheet;
  });
  const format = window.RelaxEyesCodexPetFormat;
  const cellWidth = format.cellWidth;
  const cellHeight = format.cellHeight;
  if (image.naturalWidth !== format.width || image.naturalHeight !== format.height) {
    throw new Error(`Codex preview atlas must be ${format.width} x ${format.height}`);
  }
  const padding = 20;
  const scale = Math.min(
    (canvas.width - padding * 2) / cellWidth,
    (canvas.height - padding * 2) / cellHeight,
  );
  const drawWidth = cellWidth * scale;
  const drawHeight = cellHeight * scale;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    0,
    0,
    cellWidth,
    cellHeight,
    (canvas.width - drawWidth) / 2,
    (canvas.height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  return canvas.toDataURL("image/png");
}

function readDraft() {
  return {
    displayScale: Number(range.value) / 100,
    intervalMinutes: Number(intervalInput.value),
    restSeconds: Number(restInput.value),
    reminderTitle: titleInput.value,
    reminderBody: bodyInput.value,
    eyeBreakEnabled: eyeBreakEnabled.checked,
    reminderAccent: reminderAccent.value,
    weeklyReportEnabled: weeklyReportEnabled.checked,
    weeklyReportWeekday: Number(weeklyReportWeekday.value),
    weeklyReportTime: weeklyReportTime.value,
    weeklyReportTitle: weeklyReportTitle.value,
    weeklyReportBody: weeklyReportBody.value,
    weeklyReportAccent: weeklyReportAccent.value,
    codexEnabled: codexEnabled.checked,
    soundVolume: Number(soundVolume.value) / 100,
    codexBubbleScale: Number(codexBubbleScale.value) / 100,
    codexCompletedAccent: codexCompletedAccent.value,
    codexWaitingAccent: codexWaitingAccent.value,
    codexFailedAccent: codexFailedAccent.value,
    codexStartedAccent: codexStartedAccent.value,
    visiblePets: [...visiblePetsDraft],
  };
}

function draftSignature(draft) {
  return JSON.stringify(draft);
}

function setDirty(nextDirty) {
  dirty = Boolean(nextDirty);
  if (!saving) saveStatus.textContent = dirty ? "有未保存修改" : "已保存";
  saveButton.disabled = saving || !dirty;
}

function refreshDirtyState() {
  if (!savedDraft) return;
  setDirty(draftSignature(readDraft()) !== draftSignature(savedDraft));
}

function updateSettings(state) {
  const source = state || {};
  if (source.model) currentModelId = source.model;
  if (dirty || saving) {
    renderPetVisibility();
    return;
  }
  const scale = Math.round(Number(source.displayScale ?? DEFAULTS.displayScale) * 100);
  range.value = String(Math.max(15, Math.min(100, Number.isFinite(scale) ? scale : 35)));
  intervalInput.value = String(Math.round(Number(source.intervalMs || 1200000) / 60000));
  restInput.value = String(Math.round(Number(source.restDurationMs || 20000) / 1000));
  titleInput.value = source.reminderTitle || DEFAULTS.reminderTitle;
  bodyInput.value = source.reminderBody || DEFAULTS.reminderBody;
  eyeBreakEnabled.checked = source.eyeBreakEnabled !== false;
  reminderAccent.value = validAccent(source.reminderAccent, DEFAULTS.reminderAccent);
  weeklyReportEnabled.checked = source.weeklyReportEnabled !== false;
  weeklyReportWeekday.value = String(source.weeklyReportWeekday || DEFAULTS.weeklyReportWeekday);
  weeklyReportTime.value = source.weeklyReportTime || DEFAULTS.weeklyReportTime;
  weeklyReportTitle.value = source.weeklyReportTitle || DEFAULTS.weeklyReportTitle;
  weeklyReportBody.value = source.weeklyReportBody || DEFAULTS.weeklyReportBody;
  weeklyReportAccent.value = validAccent(source.weeklyReportAccent, DEFAULTS.weeklyReportAccent);
  codexEnabled.checked = source.codexEnabled !== false;
  const volume = Math.round(Number(source.soundVolume ?? DEFAULTS.soundVolume) * 100);
  soundVolume.value = String(Math.max(0, Math.min(100, Number.isFinite(volume) ? volume : 65)));
  const bubbleScale = Math.round(Number(source.codexBubbleScale ?? DEFAULTS.codexBubbleScale) * 100);
  codexBubbleScale.value = String(Math.max(70, Math.min(140, Number.isFinite(bubbleScale) ? bubbleScale : 100)));
  codexCompletedAccent.value = validAccent(source.codexCompletedAccent, DEFAULTS.codexCompletedAccent);
  codexWaitingAccent.value = validAccent(source.codexWaitingAccent, DEFAULTS.codexWaitingAccent);
  codexFailedAccent.value = validAccent(source.codexFailedAccent, DEFAULTS.codexFailedAccent);
  codexStartedAccent.value = validAccent(source.codexStartedAccent, DEFAULTS.codexStartedAccent);
  visiblePetsDraft = normalizeVisiblePets(source.visiblePets);
  renderPetVisibility();
  updateValueLabels();
  savedDraft = readDraft();
  setDirty(false);
}

function settingsPayload(draft) {
  return {
    eyeBreak: {
      intervalMinutes: draft.intervalMinutes,
      restSeconds: draft.restSeconds,
      title: draft.reminderTitle,
      body: draft.reminderBody,
      enabled: draft.eyeBreakEnabled,
    },
    weeklyReport: {
      enabled: draft.weeklyReportEnabled,
      weekday: draft.weeklyReportWeekday,
      time: draft.weeklyReportTime,
      title: draft.weeklyReportTitle,
      body: draft.weeklyReportBody,
    },
    codex: {
      enabled: draft.codexEnabled,
      bubbleScale: draft.codexBubbleScale,
    },
    theme: {
      soundVolume: draft.soundVolume,
      reminderAccent: draft.reminderAccent,
      weeklyReportAccent: draft.weeklyReportAccent,
      codexCompletedAccent: draft.codexCompletedAccent,
      codexWaitingAccent: draft.codexWaitingAccent,
      codexFailedAccent: draft.codexFailedAccent,
      codexStartedAccent: draft.codexStartedAccent,
    },
  };
}

async function saveSettings() {
  if (saving || !dirty) return;
  const draft = readDraft();
  saving = true;
  saveStatus.textContent = "保存中...";
  saveButton.disabled = true;
  try {
    await window.relaxEyes.setDisplayScale(draft.displayScale);
    await window.relaxEyes.setReminderSettings(settingsPayload(draft));
    await window.relaxEyes.setVisiblePets(draft.visiblePets);
    const latest = await window.relaxEyes.getState();
    saving = false;
    dirty = false;
    updateSettings(latest);
  } catch (error) {
    saving = false;
    saveStatus.textContent = "保存失败，请重试";
    refreshDirtyState();
    console.error("Could not save pet settings:", error);
  }
}

function activateTab(tabName) {
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    const active = tab.dataset.tab === tabName;
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tabName;
  });
  if (tabName === "pets") startVisiblePreviews();
}

function markDraftChanged() {
  updateValueLabels();
  refreshDirtyState();
}

function applyDefaults() {
  range.value = String(DEFAULTS.displayScale * 100);
  intervalInput.value = String(DEFAULTS.intervalMinutes);
  restInput.value = String(DEFAULTS.restSeconds);
  titleInput.value = DEFAULTS.reminderTitle;
  bodyInput.value = DEFAULTS.reminderBody;
  eyeBreakEnabled.checked = DEFAULTS.eyeBreakEnabled;
  reminderAccent.value = DEFAULTS.reminderAccent;
  weeklyReportEnabled.checked = DEFAULTS.weeklyReportEnabled;
  weeklyReportWeekday.value = String(DEFAULTS.weeklyReportWeekday);
  weeklyReportTime.value = DEFAULTS.weeklyReportTime;
  weeklyReportTitle.value = DEFAULTS.weeklyReportTitle;
  weeklyReportBody.value = DEFAULTS.weeklyReportBody;
  weeklyReportAccent.value = DEFAULTS.weeklyReportAccent;
  codexEnabled.checked = DEFAULTS.codexEnabled;
  soundVolume.value = String(DEFAULTS.soundVolume * 100);
  codexBubbleScale.value = String(DEFAULTS.codexBubbleScale * 100);
  codexCompletedAccent.value = DEFAULTS.codexCompletedAccent;
  codexWaitingAccent.value = DEFAULTS.codexWaitingAccent;
  codexFailedAccent.value = DEFAULTS.codexFailedAccent;
  codexStartedAccent.value = DEFAULTS.codexStartedAccent;
  visiblePetsDraft = availablePets.map((pet) => pet.id);
  renderPetVisibility();
  markDraftChanged();
}

async function closeWindow() {
  unsavedDialog.hidden = true;
  try {
    await window.relaxEyes.closeSizePanel();
    dirty = false;
  } catch (error) {
    console.error("Could not close pet settings:", error);
  }
}

function requestClose() {
  if (saving) return;
  if (dirty) {
    unsavedDialog.hidden = false;
    continueEditingButton.focus();
    return;
  }
  void closeWindow();
}

document.querySelectorAll("[data-tab]").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

const editableControls = [
  range,
  intervalInput,
  restInput,
  titleInput,
  bodyInput,
  eyeBreakEnabled,
  reminderAccent,
  weeklyReportEnabled,
  weeklyReportWeekday,
  weeklyReportTime,
  weeklyReportTitle,
  weeklyReportBody,
  weeklyReportAccent,
  codexEnabled,
  soundVolume,
  codexBubbleScale,
  codexCompletedAccent,
  codexWaitingAccent,
  codexFailedAccent,
  codexStartedAccent,
];
editableControls.forEach((element) => {
  element.addEventListener("input", markDraftChanged);
  element.addEventListener("change", markDraftChanged);
});

resetButton.addEventListener("click", applyDefaults);
saveButton.addEventListener("click", () => void saveSettings());
closeButton.addEventListener("click", requestClose);
continueEditingButton.addEventListener("click", () => {
  unsavedDialog.hidden = true;
  closeButton.focus();
});
discardButton.addEventListener("click", () => void closeWindow());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !unsavedDialog.hidden) {
    unsavedDialog.hidden = true;
    continueEditingButton.focus();
  }
});

window.relaxEyes.onState(updateSettings);
window.relaxEyes.onSettingsCloseRequested?.(requestClose);

async function initializePetSettings() {
  try {
    const [state, pets] = await Promise.all([
      window.relaxEyes.getState(),
      window.relaxEyes.getPetCatalog(),
    ]);
    availablePets = Array.isArray(pets) ? pets : [];
    updateSettings(state);
    renderPetVisibility();
  } catch (error) {
    if (petVisibilityStatus) petVisibilityStatus.textContent = "角色目录加载失败，请重试";
    console.error("Could not load pet catalog:", error);
  }
}

void initializePetSettings();
