const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(projectRoot, "pets.json");
const outputRoot = path.join(projectRoot, "pet-packs");
const pets = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

if (!Array.isArray(pets) || pets.length === 0) {
  throw new Error("pets.json does not contain any pet definitions");
}

function buildManifest(pet) {
  const assetRoot = `assets/${pet.id}`;
  const configuredActions = Array.isArray(pet.baseAnimations) ? pet.baseAnimations : [];
  const focusPrefix = typeof pet.focusPrefix === "string" ? pet.focusPrefix : "";
  return {
    $schema: "../manifest.schema.json",
    schemaVersion: 1,
    id: pet.id,
    name: pet.label,
    engine: "spine",
    version: "1.0.0",
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

const manifests = pets.map(buildManifest);
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
