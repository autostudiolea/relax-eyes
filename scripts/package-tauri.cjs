const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const executableCandidates = [
  path.join(projectRoot, "src-tauri", "target", "release", "relax-eyes-desktop.exe"),
  path.join(projectRoot, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "relax-eyes-desktop.exe"),
];
const executable = executableCandidates.find((candidate) => fs.existsSync(candidate));
const outputRoot = path.join(projectRoot, "dist-tauri");
const stagingRoot = path.join(outputRoot, "Relax-Eyes-Tauri-Portable");
const archivePath = path.join(outputRoot, "Relax-Eyes-Tauri-Portable.zip");

if (!executable) {
  throw new Error(`Tauri executable not found. Checked:\n${executableCandidates.join("\n")}`);
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(stagingRoot, "data"), { recursive: true });
fs.copyFileSync(executable, path.join(stagingRoot, "Relax-Eyes-Tauri-Portable.exe"));
fs.writeFileSync(
  path.join(stagingRoot, "README.txt"),
  "Run Relax-Eyes-Tauri-Portable.exe. Runtime settings are stored in the data folder.\r\n",
  "utf8",
);

const escapedStaging = stagingRoot.replace(/'/g, "''");
const escapedArchive = archivePath.replace(/'/g, "''");
childProcess.execFileSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${escapedStaging}' -DestinationPath '${escapedArchive}' -Force`],
  { stdio: "inherit" },
);

console.log(`Created ${archivePath}`);
