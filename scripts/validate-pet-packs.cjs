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
function resolveProjectAsset(assetPath) {
  const relativePath = String(assetPath || "").replace(/^\//, "");
  const absolutePath = path.resolve(projectRoot, relativePath);
  const relativeToRoot = path.relative(projectRoot, absolutePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`pet asset escapes project root: ${assetPath}`);
  }
  return absolutePath;
}

function requireAsset(assetPath) {
  const absolutePath = resolveProjectAsset(assetPath);
  if (!fs.existsSync(absolutePath)) throw new Error(`missing pet asset: ${absolutePath}`);
}

for (const pack of catalog.packs) {
  if (!pack || typeof pack.id !== "string" || ids.has(pack.id)) {
    throw new Error("pet-pack ids must be non-empty and unique");
  }
  ids.add(pack.id);
  const manifestPath = path.join(packsRoot, pack.id, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.id !== pack.id || manifest.engine !== pack.engine) {
    throw new Error(`invalid pet manifest: ${manifestPath}`);
  }
  if (manifest.engine === "spine") {
    for (const assetPath of [manifest.assets.skeleton, manifest.assets.atlas, ...(manifest.assets.textures || [])]) {
      requireAsset(assetPath);
    }
  } else if (manifest.engine === "image") {
    const sources = [manifest.assets.source, ...(manifest.assets.frames || [])].filter(Boolean);
    if (!sources.length) throw new Error(`image manifest has no source: ${manifestPath}`);
    for (const assetPath of sources) requireAsset(assetPath);
  } else if (manifest.engine === "sprite") {
    if (!manifest.assets.spritesheet || !manifest.assets.metadata) {
      throw new Error(`sprite manifest is missing spritesheet or metadata: ${manifestPath}`);
    }
    requireAsset(manifest.assets.spritesheet);
    requireAsset(manifest.assets.metadata);
    const metadata = JSON.parse(fs.readFileSync(resolveProjectAsset(manifest.assets.metadata), "utf8"));
    const frames = Array.isArray(metadata.frames)
      ? metadata.frames
      : metadata.frames && typeof metadata.frames === "object"
        ? Object.entries(metadata.frames).map(([id, frame]) => ({ ...(frame || {}), id: frame?.id || id }))
        : [];
    if (!frames.length) throw new Error(`sprite metadata has no frames: ${manifest.assets.metadata}`);
    for (const frame of frames) {
      if (!frame || Number(frame.width) <= 0 || Number(frame.height) <= 0 || Number(frame.x) < 0 || Number(frame.y) < 0) {
        throw new Error(`invalid sprite frame in ${manifest.assets.metadata}`);
      }
    }
  } else if (manifest.engine === "codex-webp") {
    if (!manifest.assets.spritesheet || !manifest.atlas) {
      throw new Error(`codex-webp manifest is missing spritesheet or atlas definition: ${manifestPath}`);
    }
    requireAsset(manifest.assets.spritesheet);
    const atlas = manifest.atlas;
    const expectedStates = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"];
    if (atlas.format !== "codex-fixed-grid"
      || atlas.width !== 1536
      || atlas.height !== 1872
      || atlas.columns !== 8
      || atlas.rows !== 9
      || atlas.cellWidth !== 192
      || atlas.cellHeight !== 208
      || JSON.stringify(atlas.states) !== JSON.stringify(expectedStates)) {
      throw new Error(`invalid Codex fixed-grid definition: ${manifestPath}`);
    }
  } else {
    throw new Error(`unsupported pet engine ${manifest.engine}: ${manifestPath}`);
  }
  if (manifest.preview?.static) requireAsset(manifest.preview.static);
  for (const assetPath of Object.values(manifest.preview?.actions || {})) {
    requireAsset(assetPath);
  }
}

console.log(`Validated ${catalog.packs.length} pet-pack manifests`);
