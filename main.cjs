const { app, BrowserWindow, Menu, screen, Tray, nativeImage, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const petCatalogTools = require("./pet-catalog.js");

const APP_ROOT = __dirname;
const DATA_ROOT = process.env.PORTABLE_EXECUTABLE_DIR
  ? path.join(path.resolve(process.env.PORTABLE_EXECUTABLE_DIR), "data")
  : APP_ROOT;
const STATE_PATH = path.join(DATA_ROOT, "state.json");
const PETS_PATH = path.join(APP_ROOT, "pets.json");
const PET_PACK_CATALOG_PATH = path.join(APP_ROOT, "pet-packs", "catalog.json");
const INTERACTIONS_PATH = path.join(APP_ROOT, "interactions.json");
const BASE_WINDOW_SIZE = 360;
const WINDOW_REFERENCE_SCALE = 0.68;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 120 * 60 * 1000;
const DEBUG_INTERVAL_MS = 10 * 1000;
const DEFAULT_DISPLAY_SCALE = 0.35;
const MIN_DISPLAY_SCALE = 0.15;
const MAX_DISPLAY_SCALE = 1;
const MIN_REST_DURATION_MS = 5 * 1000;
const MAX_REST_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_REST_DURATION_MS = 20 * 1000;
const DEFAULT_REMINDER_TITLE = "该放松一下眼睛了";
const DEFAULT_REMINDER_BODY = "看向远处 {seconds} 秒，或者点击宠物确认已经休息。";
const EDGE_SNAP_DISTANCE = 48;
const MIN_WINDOW_SIZE = 80;
const MAX_CONTENT_INSET = 0.45;
const REMINDER_ALERT_WIDTH = 440;
const REMINDER_ALERT_HEIGHT = 210;
const REMINDER_ALERT_DURATION_MS = 15000;

let petWindow = null;
let sizeWindow = null;
let reminderWindow = null;
let settingsTimer = null;
let tray = null;
let server = null;
let serverPort = null;
let isQuitting = false;
let timerHandle = null;
let reminderWindowTimer = null;
let contentInsets = { left: 0, top: 0, right: 0, bottom: 0 };
const availableActionsByModel = new Map();

function loadPetCatalog() {
  try {
    const catalog = JSON.parse(fs.readFileSync(PET_PACK_CATALOG_PATH, "utf8"));
    const pets = Array.isArray(catalog.packs)
      ? catalog.packs
        .map(petCatalogTools.normalizePack)
        .filter((pet) => pet?.engine === "spine" && pet.skeleton && pet.atlas)
      : [];
    if (pets.length) return pets;
  } catch {
    // Fall back to the legacy catalog below.
  }
  try {
    const pets = JSON.parse(fs.readFileSync(PETS_PATH, "utf8"));
    return Array.isArray(pets)
      ? pets.map(petCatalogTools.normalizeLegacyPet).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

const petCatalog = loadPetCatalog();
let state = loadState();

app.setPath("userData", path.join(DATA_ROOT, "user-data"));
app.setPath("sessionData", path.join(DATA_ROOT, "session-data"));
app.setPath("cache", path.join(DATA_ROOT, "cache"));
app.setPath("logs", path.join(DATA_ROOT, "logs"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
if (process.env.PORTABLE_EXECUTABLE_DIR) app.commandLine.appendSwitch("no-sandbox");

function defaultState() {
  return {
    model: "tutu",
    intervalMs: 20 * 60 * 1000,
    paused: false,
    phase: "active",
    nextDueAt: Date.now() + 20 * 60 * 1000,
    dueAt: 0,
    position: null,
    displayScale: DEFAULT_DISPLAY_SCALE,
    restDurationMs: DEFAULT_REST_DURATION_MS,
    reminderTitle: DEFAULT_REMINDER_TITLE,
    reminderBody: DEFAULT_REMINDER_BODY,
  };
}

function clampInterval(value) {
  if (!Number.isFinite(value)) return 20 * 60 * 1000;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(value)));
}

function clampDisplayScale(value) {
  if (!Number.isFinite(value)) return DEFAULT_DISPLAY_SCALE;
  return Math.min(MAX_DISPLAY_SCALE, Math.max(MIN_DISPLAY_SCALE, value));
}

function clampRestDuration(value) {
  if (!Number.isFinite(value)) return DEFAULT_REST_DURATION_MS;
  return Math.min(MAX_REST_DURATION_MS, Math.max(MIN_REST_DURATION_MS, Math.round(value)));
}

function cleanReminderText(value, fallback, maximumLength) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximumLength) : fallback;
}

function loadInteractionCatalog() {
  try {
    const actions = JSON.parse(fs.readFileSync(INTERACTIONS_PATH, "utf8"));
    return Array.isArray(actions) ? actions : [];
  } catch {
    return [];
  }
}

const interactionCatalog = loadInteractionCatalog();

function windowSizeForScale(displayScale) {
  return Math.max(
    MIN_WINDOW_SIZE,
    Math.round(BASE_WINDOW_SIZE * clampDisplayScale(Number(displayScale)) / WINDOW_REFERENCE_SCALE),
  );
}

function loadState() {
  const fallback = defaultState();
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    const intervalMs = clampInterval(Number(saved.intervalMs));
    const model = typeof saved.model === "string" && petCatalog.some((pet) => pet.id === saved.model)
      ? saved.model
      : fallback.model;
    return {
      model,
      intervalMs,
      paused: Boolean(saved.paused),
      phase: saved.phase === "due" ? "due" : "active",
      nextDueAt: Number.isFinite(Number(saved.nextDueAt)) ? Number(saved.nextDueAt) : Date.now() + intervalMs,
      dueAt: Number.isFinite(Number(saved.dueAt)) ? Number(saved.dueAt) : 0,
      position: isPosition(saved.position) ? saved.position : null,
      displayScale: clampDisplayScale(Number(saved.displayScale)),
      restDurationMs: clampRestDuration(Number(saved.restDurationMs)),
      reminderTitle: cleanReminderText(saved.reminderTitle, DEFAULT_REMINDER_TITLE, 80),
      reminderBody: cleanReminderText(saved.reminderBody, DEFAULT_REMINDER_BODY, 240),
    };
  } catch {
    return fallback;
  }
}

function isPosition(value) {
  return value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y));
}

function saveState() {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.warn("Could not persist local state:", error.message);
  }
}

function snapshot() {
  const remainingMs = state.phase === "active" && !state.paused
    ? Math.max(0, state.nextDueAt - Date.now())
    : 0;
  return { ...state, remainingMs };
}

function sendState() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send("relax-eyes:state", snapshot());
  }
  if (sizeWindow && !sizeWindow.isDestroyed()) {
    sizeWindow.webContents.send("relax-eyes:state", snapshot());
  }
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.webContents.send("relax-eyes:state", snapshot());
  }
  updateTrayMenu();
}

function sendEvent(type, payload = {}) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send("relax-eyes:event", { type, ...payload });
  }
}

function resetTimer(source = "manual") {
  state.phase = "active";
  state.paused = false;
  state.dueAt = 0;
  state.nextDueAt = Date.now() + state.intervalMs;
  hideReminderWindow();
  saveState();
  sendEvent("timer-reset", { source });
  sendState();
  scheduleTimer();
}

function markDue() {
  if (state.phase === "due") return;
  state.phase = "due";
  state.dueAt = Date.now();
  saveState();
  sendEvent("reminder-due");
  sendState();
  showReminderWindow();
}

function scheduleTimer() {
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = null;
  if (state.paused || state.phase === "due") return;
  const delay = Math.max(100, Math.min(60 * 1000, state.nextDueAt - Date.now()));
  timerHandle = setTimeout(() => {
    if (Date.now() >= state.nextDueAt) markDue();
    else scheduleTimer();
  }, delay);
}

function togglePause() {
  if (state.phase === "due") return;
  if (state.paused) {
    state.paused = false;
    state.nextDueAt = Date.now() + Math.max(MIN_INTERVAL_MS, state.pausedRemainingMs || state.intervalMs);
    delete state.pausedRemainingMs;
  } else {
    state.pausedRemainingMs = Math.max(MIN_INTERVAL_MS, state.nextDueAt - Date.now());
    state.paused = true;
  }
  saveState();
  sendState();
  scheduleTimer();
}

function setReminderSettings(settings) {
  if (!settings || typeof settings !== "object") return;
  let intervalChanged = false;
  if (Object.prototype.hasOwnProperty.call(settings, "intervalMinutes")) {
    const minutes = Number(settings.intervalMinutes);
    if (Number.isFinite(minutes)) {
      const nextInterval = clampInterval(minutes * 60 * 1000);
      intervalChanged = nextInterval !== state.intervalMs;
      state.intervalMs = nextInterval;
    }
  }
  if (Object.prototype.hasOwnProperty.call(settings, "restSeconds")) {
    const seconds = Number(settings.restSeconds);
    if (Number.isFinite(seconds)) state.restDurationMs = clampRestDuration(seconds * 1000);
  }
  if (Object.prototype.hasOwnProperty.call(settings, "title")) {
    state.reminderTitle = cleanReminderText(settings.title, DEFAULT_REMINDER_TITLE, 80);
  }
  if (Object.prototype.hasOwnProperty.call(settings, "body")) {
    state.reminderBody = cleanReminderText(settings.body, DEFAULT_REMINDER_BODY, 240);
  }
  if (intervalChanged) {
    resetTimer("interval-change");
    return;
  }
  saveState();
  sendState();
}

function setIntervalMinutes(minutes) {
  setReminderSettings({ intervalMinutes: minutes });
}

function setRestDurationSeconds(seconds) {
  setReminderSettings({ restSeconds: seconds });
}

function setDisplayScale(value) {
  state.displayScale = clampDisplayScale(Number(value));
  resizePetWindow(state.displayScale);
  saveState();
  sendState();
}

function currentModelLabel() {
  return petCatalog.find((pet) => pet.id === state.model)?.label || "桌面宠物";
}

function formatReminderBody() {
  const seconds = Math.round(state.restDurationMs / 1000);
  return (state.reminderBody || DEFAULT_REMINDER_BODY)
    .replaceAll("{seconds}", String(seconds))
    .replaceAll("{restSeconds}", String(seconds));
}

function clearReminderWindowTimer() {
  if (reminderWindowTimer) clearTimeout(reminderWindowTimer);
  reminderWindowTimer = null;
}

function hideReminderWindow() {
  clearReminderWindowTimer();
  if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.hide();
}

function reminderRectOverlapsPet(x, y, width, height) {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const petBounds = petWindow.getBounds();
  return x < petBounds.x + petBounds.width
    && x + width > petBounds.x
    && y < petBounds.y + petBounds.height
    && y + height > petBounds.y;
}

function reminderWindowPosition() {
  const width = REMINDER_ALERT_WIDTH;
  const height = REMINDER_ALERT_HEIGHT;
  const [petX, petY] = petWindow && !petWindow.isDestroyed()
    ? petWindow.getPosition()
    : [0, 0];
  const display = screen.getDisplayNearestPoint({
    x: Math.round(petX + windowSizeForScale(state.displayScale) / 2),
    y: Math.round(petY + windowSizeForScale(state.displayScale) / 2),
  });
  const area = display.workArea;
  const inset = 24;
  const maxX = Math.max(area.x, area.x + area.width - width - inset);
  const maxY = Math.max(area.y, area.y + area.height - height - inset);
  const candidates = [
    { x: area.x + Math.round((area.width - width) / 2), y: area.y + inset },
    { x: area.x + inset, y: area.y + inset },
    { x: maxX, y: area.y + inset },
    { x: area.x + Math.round((area.width - width) / 2), y: maxY },
  ].map((candidate) => ({
    x: Math.max(area.x, Math.min(Math.round(candidate.x), maxX)),
    y: Math.max(area.y, Math.min(Math.round(candidate.y), maxY)),
  }));
  return candidates.find((candidate) => !reminderRectOverlapsPet(candidate.x, candidate.y, width, height))
    || candidates[0];
}

function showReminderWindow() {
  if (!serverPort || !app.isReady() || state.phase !== "due") return;
  const position = reminderWindowPosition();
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.setBounds({
      x: position.x,
      y: position.y,
      width: REMINDER_ALERT_WIDTH,
      height: REMINDER_ALERT_HEIGHT,
    }, false);
    reminderWindow.show();
    sendState();
  } else {
    reminderWindow = new BrowserWindow({
      width: REMINDER_ALERT_WIDTH,
      height: REMINDER_ALERT_HEIGHT,
      x: position.x,
      y: position.y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(APP_ROOT, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    reminderWindow.setAlwaysOnTop(true, "floating");
    reminderWindow.on("closed", () => {
      clearReminderWindowTimer();
      reminderWindow = null;
    });
    reminderWindow.webContents.on("did-finish-load", () => {
      if (state.phase === "due" && reminderWindow && !reminderWindow.isDestroyed()) {
        reminderWindow.show();
        sendState();
      }
    });
    reminderWindow.loadURL(`http://127.0.0.1:${serverPort}/reminder.html`).catch((error) => {
      console.warn("Could not open reminder window:", error.message);
    });
  }
  clearReminderWindowTimer();
  reminderWindowTimer = setTimeout(hideReminderWindow, REMINDER_ALERT_DURATION_MS);
}

function normalizeActionNames(names) {
  if (!Array.isArray(names)) return [];
  const seen = new Set();
  return names
    .filter((name) => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => name && !seen.has(name) && seen.add(name));
}

function availableActionsForPet(pet) {
  const dynamic = normalizeActionNames(availableActionsByModel.get(pet?.id));
  if (dynamic.length) return dynamic;
  return normalizeActionNames(pet?.baseAnimations);
}

function setAvailableModelActions(modelId, names) {
  if (!petCatalog.some((pet) => pet.id === modelId)) return;
  const normalized = normalizeActionNames(names);
  if (!normalized.length) return;
  availableActionsByModel.set(modelId, normalized);
  updateTrayMenu();
}

function formatRemaining(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function timerMenuLabel() {
  if (state.phase === "due") return "休息提醒已到";
  if (state.paused) return "提醒已暂停";
  return `下次提醒：${formatRemaining(Math.max(0, state.nextDueAt - Date.now()))}`;
}

function changeModel(modelId) {
  if (!petCatalog.some((pet) => pet.id === modelId) || state.model === modelId) return;
  state.model = modelId;
  saveState();
  sendEvent("model-change", { model: modelId });
  sendState();
}

function menuTemplate() {
  const intervalOptions = [20, 30, 45, 60].map((minutes) => ({
    label: `${minutes} 分钟`,
    type: "radio",
    checked: Math.round(state.intervalMs / 60000) === minutes,
    click: () => setIntervalMinutes(minutes),
  }));
  intervalOptions.push(
    { type: "separator" },
    { label: "自定义...", click: openSizePanel },
  );
  const restDurationOptions = [20, 30, 60, 120].map((seconds) => ({
    label: `${seconds} 秒`,
    type: "radio",
    checked: Math.round(state.restDurationMs / 1000) === seconds,
    click: () => setRestDurationSeconds(seconds),
  }));
  restDurationOptions.push(
    { type: "separator" },
    { label: "自定义...", click: openSizePanel },
  );
  const sizePresets = [
    { label: "极小 15%", value: 0.15 },
    { label: "超小 20%", value: 0.2 },
    { label: "小 25%", value: 0.25 },
    { label: "默认 35%", value: 0.35 },
    { label: "中 55%", value: 0.55 },
    { label: "大 68%", value: 0.68 },
    { label: "特大 100%", value: 1 },
  ].map(({ label, value }) => ({
    label,
    type: "radio",
    checked: Math.abs(state.displayScale - value) < 0.001,
    click: () => setDisplayScale(value),
  }));
  const sizeOptions = [
    { label: "滑动调整...", click: openSizePanel },
    { type: "separator" },
    ...sizePresets,
  ];
  const currentPet = petCatalog.find((pet) => pet.id === state.model);
  const baseAnimationNames = availableActionsForPet(currentPet);
  const actionOptions = baseAnimationNames.length
    ? baseAnimationNames.map((name) => ({
      label: name,
      click: () => sendEvent("play-animation", { name }),
    }))
    : [{ label: "动作加载中...", enabled: false }];
  const petOptions = petCatalog.map((pet) => ({
    label: pet.label,
    type: "radio",
    checked: state.model === pet.id,
    click: () => changeModel(pet.id),
  }));
  return [
    { label: currentModelLabel(), enabled: false },
    { label: timerMenuLabel(), enabled: false },
    { type: "separator" },
    {
      label: "切换宠物",
      submenu: petOptions,
    },
    {
      label: "提醒间隔",
      submenu: intervalOptions,
    },
    {
      label: "休息时长",
      submenu: restDurationOptions,
    },
    { label: "编辑提醒文案...", click: openSizePanel },
    {
      label: "显示大小",
      submenu: sizeOptions,
    },
    {
      label: "动作",
      submenu: actionOptions,
    },
    {
      label: state.paused ? "恢复提醒" : "暂停提醒",
      enabled: state.phase !== "due",
      click: togglePause,
    },
    { label: "立即重置计时", click: () => resetTimer("menu") },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } },
  ];
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function clampContentInset(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(MAX_CONTENT_INSET, Math.max(0, numeric));
}

function contentInsetsInPixels(windowWidth, windowHeight = windowWidth, insets = contentInsets) {
  return {
    left: Math.round(windowWidth * clampContentInset(insets.left)),
    top: Math.round(windowHeight * clampContentInset(insets.top)),
    right: Math.round(windowWidth * clampContentInset(insets.right)),
    bottom: Math.round(windowHeight * clampContentInset(insets.bottom)),
  };
}

function clampWindowPosition(x, y, windowSize = windowSizeForScale(state.displayScale)) {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(Number(x) + windowSize / 2),
    y: Math.round(Number(y) + windowSize / 2),
  });
  const area = display.workArea;
  const insets = contentInsetsInPixels(windowSize);
  const minX = area.x - insets.left;
  const maxX = area.x + area.width - windowSize + insets.right;
  const minY = area.y - insets.top;
  const maxY = area.y + area.height - windowSize + insets.bottom;
  const lowerX = Math.min(minX, maxX);
  const upperX = Math.max(minX, maxX);
  const lowerY = Math.min(minY, maxY);
  const upperY = Math.max(minY, maxY);
  const numericX = Number.isFinite(Number(x)) ? Math.round(Number(x)) : lowerX;
  const numericY = Number.isFinite(Number(y)) ? Math.round(Number(y)) : lowerY;
  return {
    x: Math.max(lowerX, Math.min(numericX, upperX)),
    y: Math.max(lowerY, Math.min(numericY, upperY)),
  };
}

function initialPosition() {
  const windowSize = windowSizeForScale(state.displayScale);
  if (isPosition(state.position)) return clampWindowPosition(state.position.x, state.position.y, windowSize);
  const area = screen.getPrimaryDisplay().workArea;
  const insets = contentInsetsInPixels(windowSize);
  return clampWindowPosition(
    area.x + area.width - windowSize + insets.right,
    area.y + area.height - windowSize + insets.bottom,
    windowSize,
  );
}

function resizePetWindow(displayScale) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const nextSize = windowSizeForScale(displayScale);
  const [x, y] = petWindow.getPosition();
  const [oldWidth, oldHeight] = petWindow.getSize();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + oldWidth / 2),
    y: Math.round(y + oldHeight / 2),
  });
  const area = display.workArea;
  const oldInsets = contentInsetsInPixels(oldWidth, oldHeight);
  const nextInsets = contentInsetsInPixels(nextSize);
  const rightWindowGap = area.x + area.width - (x + oldWidth);
  const rightContentGap = area.x + area.width - (x + oldWidth - oldInsets.right);
  const bottomWindowGap = area.y + area.height - (y + oldHeight);
  const bottomContentGap = area.y + area.height - (y + oldHeight - oldInsets.bottom);
  const leftWindowGap = x - area.x;
  const leftContentGap = x + oldInsets.left - area.x;
  const topWindowGap = y - area.y;
  const topContentGap = y + oldInsets.top - area.y;
  const isNearEdge = (first, second) => Math.min(Math.abs(first), Math.abs(second)) <= EDGE_SNAP_DISTANCE;
  const nextX = isNearEdge(rightWindowGap, rightContentGap)
    ? area.x + area.width - nextSize + nextInsets.right
    : isNearEdge(leftWindowGap, leftContentGap)
      ? area.x - nextInsets.left
      : x + Math.round((oldWidth - nextSize) / 2);
  const nextY = isNearEdge(bottomWindowGap, bottomContentGap)
    ? area.y + area.height - nextSize + nextInsets.bottom
    : isNearEdge(topWindowGap, topContentGap)
      ? area.y - nextInsets.top
      : y + Math.round((oldHeight - nextSize) / 2);
  const nextPosition = clampWindowPosition(nextX, nextY, nextSize);
  state.position = nextPosition;
  petWindow.setBounds({
    x: nextPosition.x,
    y: nextPosition.y,
    width: nextSize,
    height: nextSize,
  }, false);
}

function setContentInsets(value) {
  if (!value || typeof value !== "object") return;
  const nextInsets = {
    left: clampContentInset(value.left),
    top: clampContentInset(value.top),
    right: clampContentInset(value.right),
    bottom: clampContentInset(value.bottom),
  };
  const changed = Object.keys(nextInsets).some((key) => nextInsets[key] !== contentInsets[key]);
  if (!changed) return;
  contentInsets = nextInsets;
  if (petWindow && !petWindow.isDestroyed()) {
    const [x, y] = petWindow.getPosition();
    const [width, height] = petWindow.getSize();
    const display = screen.getDisplayNearestPoint({
      x: Math.round(x + width / 2),
      y: Math.round(y + height / 2),
    });
    const area = display.workArea;
    const insets = contentInsetsInPixels(width, height);
    const rightWindowGap = area.x + area.width - (x + width);
    const rightContentGap = area.x + area.width - (x + width - insets.right);
    const bottomWindowGap = area.y + area.height - (y + height);
    const bottomContentGap = area.y + area.height - (y + height - insets.bottom);
    const leftWindowGap = x - area.x;
    const leftContentGap = x + insets.left - area.x;
    const topWindowGap = y - area.y;
    const topContentGap = y + insets.top - area.y;
    const isNearEdge = (first, second) => Math.min(Math.abs(first), Math.abs(second)) <= EDGE_SNAP_DISTANCE;
    const nextX = isNearEdge(rightWindowGap, rightContentGap)
      ? area.x + area.width - width + insets.right
      : isNearEdge(leftWindowGap, leftContentGap)
        ? area.x - insets.left
        : x;
    const nextY = isNearEdge(bottomWindowGap, bottomContentGap)
      ? area.y + area.height - height + insets.bottom
      : isNearEdge(topWindowGap, topContentGap)
        ? area.y - insets.top
        : y;
    const nextPosition = clampWindowPosition(nextX, nextY, width);
    state.position = nextPosition;
    petWindow.setPosition(nextPosition.x, nextPosition.y, false);
    saveState();
  }
  sendState();
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".cjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".atlas": "text/plain; charset=utf-8",
    ".skel": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8",
  }[extension] || "application/octet-stream";
}

function startAssetServer() {
  server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const relativePath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^\/+/, "");
      const filePath = path.resolve(APP_ROOT, relativePath);
      const relativeCheck = path.relative(APP_ROOT, filePath);
      if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck) || relativeCheck === "state.json") {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      response.writeHead(200, { "Content-Type": mimeType(filePath), "Cache-Control": "no-store" });
      fs.createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(400);
      response.end("Bad request");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve(serverPort);
    });
  });
}

function createPetWindow() {
  const windowSize = windowSizeForScale(state.displayScale);
  const position = initialPosition();
  petWindow = new BrowserWindow({
    width: windowSize,
    height: windowSize,
    minWidth: 1,
    minHeight: 1,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  petWindow.setAlwaysOnTop(true, "floating");
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  petWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      petWindow.hide();
    }
  });
  petWindow.on("move", () => {
    if (!petWindow.isDestroyed()) {
      const [x, y] = petWindow.getPosition();
      state.position = { x, y };
      sendState();
    }
  });
  petWindow.webContents.on("did-finish-load", () => {
    petWindow.showInactive();
    sendState();
    if (state.phase === "due") {
      sendEvent("reminder-due");
      showReminderWindow();
    }
  });
}

function openContextMenu() {
  if (!petWindow || petWindow.isDestroyed()) return;
  Menu.buildFromTemplate(menuTemplate()).popup({ window: petWindow });
}

function openSizePanel() {
  if (!serverPort) return;
  if (sizeWindow && !sizeWindow.isDestroyed()) {
    sizeWindow.show();
    sizeWindow.focus();
    return;
  }

  const width = 420;
  const height = 380;
  const [petX, petY] = petWindow && !petWindow.isDestroyed()
    ? petWindow.getPosition()
    : [0, 0];
  const display = screen.getDisplayNearestPoint({
    x: Math.round(petX + width / 2),
    y: Math.round(petY + height / 2),
  });
  const area = display.workArea;
  const preferredX = petX + Math.round((windowSizeForScale(state.displayScale) - width) / 2);
  const preferredY = petY - height - 12;
  const x = Math.max(area.x, Math.min(Math.round(preferredX), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(Math.round(preferredY), area.y + area.height - height));

  sizeWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  sizeWindow.setAlwaysOnTop(true, "floating");
  sizeWindow.on("closed", () => {
    sizeWindow = null;
  });
  sizeWindow.loadURL(`http://127.0.0.1:${serverPort}/size.html`).then(() => {
    if (sizeWindow && !sizeWindow.isDestroyed()) {
      sizeWindow.show();
      sizeWindow.focus();
    }
  }).catch((error) => {
    console.warn("Could not open size panel:", error.message);
  });
}

async function createTray() {
  const iconPath = path.join(APP_ROOT, "tray-icon.png");
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("Relax Eyes");
  tray.on("click", () => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.showInactive();
  });
  updateTrayMenu();
}

async function bootstrap() {
  await app.whenReady();
  const port = await startAssetServer();
  createPetWindow();
  await petWindow.loadURL(`http://127.0.0.1:${port}/index.html`);
  await createTray();
  if (process.argv.includes("--debug-timer")) {
    state.intervalMs = DEBUG_INTERVAL_MS;
    resetTimer("debug");
  } else {
    scheduleTimer();
  }
  settingsTimer = setInterval(sendState, 1000);
}

ipcMain.handle("relax-eyes:get-state", () => snapshot());
ipcMain.handle("relax-eyes:begin-drag", () => {
  if (!petWindow || petWindow.isDestroyed()) return { x: 0, y: 0 };
  const [x, y] = petWindow.getPosition();
  return { x, y };
});
ipcMain.on("relax-eyes:move-window", (_event, position) => {
  if (!petWindow || petWindow.isDestroyed() || !isPosition(position)) return;
  const [windowWidth] = petWindow.getSize();
  const next = clampWindowPosition(position.x, position.y, windowWidth);
  petWindow.setPosition(next.x, next.y, false);
});
ipcMain.on("relax-eyes:end-drag", (_event, position) => {
  if (!petWindow || petWindow.isDestroyed() || !isPosition(position)) return;
  const [windowWidth] = petWindow.getSize();
  const next = clampWindowPosition(position.x, position.y, windowWidth);
  petWindow.setPosition(next.x, next.y, false);
  state.position = next;
  saveState();
  sendState();
});
ipcMain.on("relax-eyes:pet-click", () => {
  if (state.phase === "due") {
    resetTimer("pet-click");
  }
  sendEvent("pet-click");
});
ipcMain.on("relax-eyes:confirm-reminder", () => {
  if (state.phase === "due") resetTimer("reminder-window");
  else hideReminderWindow();
});
ipcMain.on("relax-eyes:open-context-menu", openContextMenu);
ipcMain.on("relax-eyes:open-size-panel", openSizePanel);
ipcMain.on("relax-eyes:set-display-scale", (_event, value) => setDisplayScale(value));
ipcMain.on("relax-eyes:set-reminder-settings", (_event, settings) => setReminderSettings(settings));
ipcMain.on("relax-eyes:set-content-insets", (_event, value) => setContentInsets(value));
ipcMain.on("relax-eyes:set-ignore-mouse", (_event, ignored) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.setIgnoreMouseEvents(Boolean(ignored), { forward: true });
});
ipcMain.on("relax-eyes:set-model-actions", (_event, payload) => {
  if (!payload || typeof payload.modelId !== "string") return;
  setAvailableModelActions(payload.modelId, payload.names);
});

app.on("before-quit", () => {
  isQuitting = true;
  if (timerHandle) clearTimeout(timerHandle);
  if (settingsTimer) clearInterval(settingsTimer);
  clearReminderWindowTimer();
  if (server) server.close();
  saveState();
});
app.on("window-all-closed", (event) => {
  if (!isQuitting) event.preventDefault();
});
app.on("activate", () => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.showInactive();
});

bootstrap().catch((error) => {
  console.error(error);
  app.quit();
});
