(function installRelaxEyesCodexPetFormat(global) {
  const WIDTH = 1536;
  const HEIGHT = 1872;
  const COLUMNS = 8;
  const ROWS = 9;
  const CELL_WIDTH = WIDTH / COLUMNS;
  const CELL_HEIGHT = HEIGHT / ROWS;
  const STATES = Object.freeze([
    "idle",
    "running-right",
    "running-left",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
  ]);
  const FPS = Object.freeze({
    idle: 6,
    "running-right": 8,
    "running-left": 8,
    waving: 6,
    jumping: 6,
    failed: 6,
    waiting: 6,
    running: 6,
    review: 6,
  });
  const DURATIONS_MS = Object.freeze({
    idle: [280, 110, 110, 140, 140, 320],
    "running-right": [120, 120, 120, 120, 120, 120, 120, 220],
    "running-left": [120, 120, 120, 120, 120, 120, 120, 220],
    waving: [140, 140, 140, 280],
    jumping: [140, 140, 140, 140, 280],
    failed: [140, 140, 140, 140, 140, 140, 140, 240],
    waiting: [150, 150, 150, 150, 150, 260],
    running: [120, 120, 120, 120, 120, 220],
    review: [150, 150, 150, 150, 150, 280],
  });
  const ALIASES = Object.freeze({
    Relax: "idle",
    Idle: "idle",
    Move: "running-right",
    Interact: "waving",
    Start: "idle",
  });

  function allColumns() {
    return Array.from({ length: COLUMNS }, (_value, index) => index);
  }

  function frameId(state, column) {
    return `${state}-${String(column + 1).padStart(2, "0")}`;
  }

  function frameRecord(state, column) {
    return {
      id: frameId(state, column),
      x: column * CELL_WIDTH,
      y: STATES.indexOf(state) * CELL_HEIGHT,
      width: CELL_WIDTH,
      height: CELL_HEIGHT,
      pivotX: 0.5,
      pivotY: 1,
    };
  }

  function frameDurations(state, count) {
    const source = DURATIONS_MS[state] || [];
    if (!source.length) return Array.from({ length: count }, () => 1000 / (FPS[state] || 6));
    if (source.length >= count) return source.slice(0, count);
    return source.concat(Array.from({ length: count - source.length }, () => source[source.length - 1]));
  }

  function normalizeColumns(value) {
    if (!Array.isArray(value)) return allColumns();
    return [...new Set(value
      .map((column) => Math.round(Number(column)))
      .filter((column) => column >= 0 && column < COLUMNS))]
      .sort((left, right) => left - right);
  }

  function buildFrames(visibleColumns = null) {
    const frames = [];
    const animations = {};
    for (const state of STATES) {
      const columns = normalizeColumns(visibleColumns?.[state]);
      const stateFrames = columns.map((column) => frameRecord(state, column));
      if (!stateFrames.length) continue;
      frames.push(...stateFrames);
      animations[state] = {
        frames: stateFrames.map((frame) => frame.id),
        fps: FPS[state] || 6,
        durations: frameDurations(state, stateFrames.length),
        loop: true,
      };
    }
    return { frames, animations };
  }

  function detectVisibleColumns(image, alphaThreshold = 8) {
    const width = Number(image?.naturalWidth || image?.width || 0);
    const height = Number(image?.naturalHeight || image?.height || 0);
    if (width !== WIDTH || height !== HEIGHT || typeof document === "undefined") return null;
    const surface = document.createElement("canvas");
    surface.width = WIDTH;
    surface.height = HEIGHT;
    const context = surface.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    try {
      context.drawImage(image, 0, 0, WIDTH, HEIGHT);
      const pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
      const rows = {};
      for (let row = 0; row < ROWS; row += 1) {
        const state = STATES[row];
        const columns = [];
        for (let column = 0; column < COLUMNS; column += 1) {
          let visible = false;
          const left = column * CELL_WIDTH;
          const top = row * CELL_HEIGHT;
          for (let y = top; y < top + CELL_HEIGHT && !visible; y += 2) {
            for (let x = left; x < left + CELL_WIDTH; x += 2) {
              if (pixels[(y * WIDTH + x) * 4 + 3] >= alphaThreshold) {
                visible = true;
                break;
              }
            }
          }
          if (visible) columns.push(column);
        }
        rows[state] = columns;
      }
      if (!Object.values(rows).some((columns) => columns.length)) {
        return Object.fromEntries(STATES.map((state) => [state, allColumns()]));
      }
      return rows;
    } catch {
      return null;
    } finally {
      surface.width = 1;
      surface.height = 1;
    }
  }

  function buildRuntimeMetadata(source, visibleColumns = null) {
    const layout = buildFrames(visibleColumns);
    return {
      ...(source && typeof source === "object" ? source : {}),
      spritesheetPath: "spritesheet.webp",
      atlas: {
        format: "codex-fixed-grid",
        width: WIDTH,
        height: HEIGHT,
        columns: COLUMNS,
        rows: ROWS,
        cellWidth: CELL_WIDTH,
        cellHeight: CELL_HEIGHT,
        states: STATES.slice(),
        visibleColumns: visibleColumns || Object.fromEntries(STATES.map((state) => [state, allColumns()])),
      },
      frames: layout.frames,
      animations: layout.animations,
      initialAnimation: source?.initialAnimation || "idle",
    };
  }

  const api = Object.freeze({
    width: WIDTH,
    height: HEIGHT,
    columns: COLUMNS,
    rows: ROWS,
    cellWidth: CELL_WIDTH,
    cellHeight: CELL_HEIGHT,
    states: STATES,
    fps: FPS,
    durations: DURATIONS_MS,
    aliases: ALIASES,
    allColumns,
    buildFrames,
    detectVisibleColumns,
    buildRuntimeMetadata,
  });
  global.RelaxEyesCodexPetFormat = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
