const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packsRoot = path.join(projectRoot, "pet-packs");
const catalogPath = path.join(packsRoot, "catalog.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));

if (!Array.isArray(catalog.packs) || catalog.packs.length === 0) {
  throw new Error("pet-packs/catalog.json does not contain any packs");
}

const ids = new Set();
for (const pack of catalog.packs) {
  if (!pack || typeof pack.id !== "string" || ids.has(pack.id)) {
    throw new Error("pet-pack ids must be non-empty and unique");
  }
  ids.add(pack.id);
  const manifestPath = path.join(packsRoot, pack.id, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.id !== pack.id || manifest.engine !== "spine") {
    throw new Error(`invalid Spine manifest: ${manifestPath}`);
  }
  for (const assetPath of [manifest.assets.skeleton, manifest.assets.atlas, ...manifest.assets.textures]) {
    const relativePath = assetPath.replace(/^\//, "");
    const absolutePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(absolutePath)) throw new Error(`missing pet asset: ${absolutePath}`);
  }
}

console.log(`Validated ${catalog.packs.length} Spine pet-pack manifests`);
