const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(projectRoot, "pets.json");
const outputRoot = path.join(projectRoot, "pet-packs");
const pets = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const existingCatalogPath = path.join(outputRoot, "catalog.json");
const existingCatalog = fs.existsSync(existingCatalogPath)
  ? JSON.parse(fs.readFileSync(existingCatalogPath, "utf8"))
  : { packs: [] };

if (!Array.isArray(pets) || pets.length === 0) {
  throw new Error("pets.json does not contain any pet definitions");
}

function buildManifest(pet) {
  const assetRoot = `assets/${pet.id}`;
  const configuredActions = Array.isArray(pet.baseAnimations) ? pet.baseAnimations : [];
  const focusPrefix = typeof pet.focusPrefix === "string" ? pet.focusPrefix : "";
  const calibration = pet.calibration || {};
  return {
    $schema: "../manifest.schema.json",
    schemaVersion: 1,
    id: pet.id,
    name: pet.label,
    engine: "spine",
    version: typeof pet.version === "string" ? pet.version : "1.0.0",
    assets: {
      sourceRoot: assetRoot,
      skeleton: pet.skeleton,
      atlas: pet.atlas,
      textures: [`/assets/${pet.id}/${pet.id}.png`],
    },
    standard: {
      referenceModel: "tutu",
      width: 360,
      height: 360,
      fitScale: Number.isFinite(Number(pet.fitScale)) ? Number(pet.fitScale) : 0.68,
      anchor: { x: 0.5, y: 1 },
      baseline: 0.92,
      safeMargin: { left: 0.02, top: 0.02, right: 0.02, bottom: 0.02 },
    },
    hit: {
      mode: focusPrefix ? "focus-prefix" : "visible-bounds",
      ...(focusPrefix ? { focusPrefix } : {}),
      padding: 0.02,
    },
    calibration: {
      offsetX: Number.isFinite(Number(calibration.offsetX)) ? Number(calibration.offsetX) : 0,
      offsetY: Number.isFinite(Number(calibration.offsetY)) ? Number(calibration.offsetY) : 0,
      scaleX: Number.isFinite(Number(calibration.scaleX)) ? Number(calibration.scaleX) : 1,
      scaleY: Number.isFinite(Number(calibration.scaleY)) ? Number(calibration.scaleY) : 1,
      hitPadding: Number.isFinite(Number(calibration.hitPadding))
        ? Number(calibration.hitPadding)
        : 0,
    },
    preview: {
      static: `/assets/${pet.id}/${pet.id}.png`,
      actions: {},
    },
    actions: {
      initial: pet.initialAnimation || "Relax",
      raw: configuredActions,
      aliases: pet.animationAliases || {},
      cooldownMs: 1800,
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

const generatedManifests = pets.map(buildManifest);
const generatedIds = new Set(generatedManifests.map((manifest) => manifest.id));
const preservedManifests = Array.isArray(existingCatalog.packs)
  ? existingCatalog.packs.filter((manifest) => manifest.engine !== "spine" && !generatedIds.has(manifest.id))
  : [];
const manifests = [...generatedManifests, ...preservedManifests];
fs.mkdirSync(outputRoot, { recursive: true });
for (const manifest of manifests) {
  const directory = path.join(outputRoot, manifest.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}
fs.writeFileSync(
  path.join(outputRoot, "catalog.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    referenceModel: "tutu",
    packs: manifests,
  }, null, 2)}\n`,
  "utf8",
);
console.log(`Generated ${manifests.length} Spine pet-pack manifests in ${outputRoot}`);
