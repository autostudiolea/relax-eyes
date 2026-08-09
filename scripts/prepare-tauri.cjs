const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const outputRoot = path.join(projectRoot, "web-dist");

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

const files = [
  "index.html",
  "styles.css",
  "renderer.js",
  "pet-catalog.js",
  "codex-pet-format.js",
  "spine-pet-adapter.js",
  "image-pet-adapter.js",
  "sprite-pet-adapter.js",
  "codex-pet-adapter.js",
  "tauri-bridge.js",
  "size.html",
  "size.js",
  "reminder.html",
  "reminder.css",
  "reminder.js",
  "interactions.json",
];

for (const file of files) {
  fs.copyFileSync(path.join(projectRoot, file), path.join(outputRoot, file));
}

for (const directory of ["assets", "vendor", "pet-packs"]) {
  fs.cpSync(path.join(projectRoot, directory), path.join(outputRoot, directory), { recursive: true });
}

console.log(`Prepared Tauri frontend in ${outputRoot}`);
