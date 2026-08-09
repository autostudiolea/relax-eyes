const childProcess = require("node:child_process");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const localCargoHome = path.join(projectRoot, ".cargo-home");
const localCargoTarget = path.join(projectRoot, "src-tauri", "target", "portable-build");
const args = process.argv.slice(2);

const result = childProcess.spawnSync("cargo-tauri", args, {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    CARGO_HOME: localCargoHome,
    CARGO_TARGET_DIR: localCargoTarget,
  },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
