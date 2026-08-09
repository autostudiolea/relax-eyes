const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const rolesRoot = path.resolve(projectRoot, "..", "role");
const assetsRoot = path.join(projectRoot, "assets");
const packsRoot = path.join(projectRoot, "pet-packs");
const catalogPath = path.join(packsRoot, "catalog.json");
const replaceExisting = process.argv.includes("--replace");

const CODEX_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

const CODEX_VISIBLE_COLUMNS = {
  idle: [0, 1, 2, 3, 4, 5],
  "running-right": [0, 1, 2, 3, 4, 5, 6, 7],
  "running-left": [0, 1, 2, 3, 4, 5, 6, 7],
  waving: [0, 1, 2, 3],
  jumping: [0, 1, 2, 3, 4],
  failed: [0, 1, 2, 3, 4, 5, 6, 7],
  waiting: [0, 1, 2, 3, 4, 5],
  running: [0, 1, 2, 3, 4, 5],
  review: [0, 1, 2, 3, 4, 5],
};

const CODEX_ATLAS = {
  format: "codex-fixed-grid",
  width: 1536,
  height: 1872,
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208,
  states: CODEX_STATES,
  visibleColumns: CODEX_VISIBLE_COLUMNS,
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function projectRelativePath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function assertSafeId(id, sourcePath) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error(`Invalid Codex pet id in ${sourcePath}: ${id}`);
  }
}

function codexManifest(pet) {
  const assetRoot = `assets/${pet.id}`;
  return {
    $schema: "../manifest.schema.json",
    schemaVersion: 1,
    id: pet.id,
    name: pet.displayName || pet.id,
    engine: "codex-webp",
    version: typeof pet.version === "string" ? pet.version : "1.0.0",
    assets: {
      sourceRoot: assetRoot,
      source: `/${assetRoot}/pet.json`,
      spritesheet: `/${assetRoot}/spritesheet.webp`,
    },
    atlas: CODEX_ATLAS,
    standard: {
      referenceModel: "tutu",
      width: 360,
      height: 360,
      fitScale: 0.68,
      anchor: { x: 0.5, y: 1 },
      baseline: 0.92,
      safeMargin: { left: 0.02, top: 0.02, right: 0.02, bottom: 0.02 },
    },
    hit: {
      mode: "opaque-pixels",
      padding: 0.02,
    },
    calibration: {
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
      hitPadding: 0,
    },
    preview: {
      static: `/${assetRoot}/spritesheet.webp`,
      actions: {},
    },
    actions: {
      initial: "idle",
      raw: CODEX_STATES,
      aliases: {
        Relax: "idle",
        Idle: "idle",
        Move: "running-right",
        Interact: "waving",
        Special: "jumping",
        Start: "idle",
      },
      cooldownMs: 1200,
      interruptible: true,
    },
    capabilities: {
      idle: true,
      click: true,
      hover: true,
      drag: true,
      run: true,
      sleep: true,
      reminder: true,
    },
  };
}

function copyFile(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function main() {
  if (!fs.existsSync(rolesRoot)) throw new Error(`Role directory does not exist: ${rolesRoot}`);
  const catalog = readJson(catalogPath);
  const existing = new Map((catalog.packs || []).map((pack) => [pack.id, pack]));
  const imported = [];

  for (const directoryName of fs.readdirSync(rolesRoot).sort()) {
    const sourceRoot = path.join(rolesRoot, directoryName);
    if (!fs.statSync(sourceRoot).isDirectory()) continue;
    const petJsonPath = path.join(sourceRoot, "pet.json");
    const spritesheetPath = path.join(sourceRoot, "spritesheet.webp");
    if (!fs.existsSync(petJsonPath)) continue;
    if (!fs.existsSync(spritesheetPath)) {
      console.warn(`Skipped ${directoryName}: spritesheet.webp is missing`);
      continue;
    }

    const pet = readJson(petJsonPath);
    const id = String(pet.id || directoryName).trim().toLowerCase();
    assertSafeId(id, petJsonPath);
    if (id !== directoryName) {
      console.warn(`Using manifest id ${id} for source directory ${directoryName}`);
    }

    const assetsDirectory = path.join(assetsRoot, id);
    const packDirectory = path.join(packsRoot, id);
    const manifestPath = path.join(packDirectory, "manifest.json");
    const targetPetJson = path.join(assetsDirectory, "pet.json");
    const targetSpritesheet = path.join(assetsDirectory, "spritesheet.webp");
    if (existing.get(id)?.engine && existing.get(id).engine !== "codex-webp") {
      throw new Error(`A non-Codex pet already uses this id: ${id}`);
    }
    if (!replaceExisting && (fs.existsSync(assetsDirectory) || fs.existsSync(packDirectory))) {
      throw new Error(`Target Codex pack already exists; remove or update explicitly: ${id}`);
    }

    const manifest = codexManifest({ ...pet, id });
    fs.mkdirSync(assetsDirectory, { recursive: true });
    fs.mkdirSync(packDirectory, { recursive: true });
    copyFile(petJsonPath, targetPetJson);
    copyFile(spritesheetPath, targetSpritesheet);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(
      path.join(packDirectory, "generation.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        status: "approved",
        source: "role",
        input: [projectRelativePath(petJsonPath), projectRelativePath(spritesheetPath)],
        output: { source: `/assets/${id}/pet.json`, spritesheet: `/assets/${id}/spritesheet.webp` },
        version: manifest.version,
      }, null, 2)}\n`,
      "utf8",
    );
    existing.set(id, manifest);
    imported.push(id);
  }

  const packs = [...existing.values()];
  fs.writeFileSync(
    catalogPath,
    `${JSON.stringify({ ...catalog, packs }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Imported ${imported.length} Codex role packs: ${imported.join(", ")}`);
}

main();
