const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packsRoot = path.join(projectRoot, "pet-packs");
const catalogPath = path.join(packsRoot, "catalog.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));

function previewForManifest(manifest) {
  const assets = manifest.assets || {};
  const actions = manifest.actions || {};
  const staticAsset = manifest.preview?.static
    || assets.source
    || assets.textures?.[0]
    || null;
  return {
    schemaVersion: 1,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    engine: manifest.engine,
    static: staticAsset,
    actions: Object.fromEntries(
      (Array.isArray(actions.raw) ? actions.raw : []).map((name) => [
        name,
        manifest.preview?.actions?.[name] || null,
      ]),
    ),
  };
}

for (const catalogPack of catalog.packs || []) {
  const manifestPath = path.join(packsRoot, catalogPack.id, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.preview ||= {
    static: previewForManifest(manifest).static,
    actions: {},
  };
  manifest.calibration ||= {
    offsetX: 0,
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
    hitPadding: 0,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(packsRoot, catalogPack.id, "preview.json"),
    `${JSON.stringify(previewForManifest(manifest), null, 2)}\n`,
    "utf8",
  );
  catalogPack.preview = manifest.preview;
  catalogPack.calibration = manifest.calibration;
}

fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`Generated ${catalog.packs.length} role preview metadata files`);
