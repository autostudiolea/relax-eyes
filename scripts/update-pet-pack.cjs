const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packsRoot = path.join(projectRoot, "pet-packs");
const catalogPath = path.join(packsRoot, "catalog.json");

function parseArgs(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!/^[a-z0-9][a-z0-9_-]*$/.test(String(options.id || ""))) {
  throw new Error("--id must contain lowercase letters, numbers, underscores, or hyphens");
}
if (!/^\d+\.\d+\.\d+$/.test(String(options.version || ""))) {
  throw new Error("--version must use MAJOR.MINOR.PATCH format");
}

const manifestPath = path.join(packsRoot, options.id, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = options.version;
if (typeof options.name === "string" && options.name.trim()) manifest.name = options.name.trim();
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const catalogPack = (catalog.packs || []).find((pack) => pack.id === options.id);
if (!catalogPack) throw new Error(`Catalog has no pack ${options.id}`);
catalogPack.name = manifest.name;
catalogPack.version = manifest.version;
catalogPack.preview = manifest.preview || catalogPack.preview;
catalogPack.calibration = manifest.calibration || catalogPack.calibration;
fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`Updated ${options.id} to version ${manifest.version}`);
