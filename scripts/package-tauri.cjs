const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const preferredExecutable = process.env.RELAX_EYES_TAURI_EXE
  ? path.resolve(projectRoot, process.env.RELAX_EYES_TAURI_EXE)
  : null;
const executableCandidates = [
  preferredExecutable,
  path.join(projectRoot, "src-tauri", "target", "portable-build", "release", "relax-eyes-desktop.exe"),
  path.join(projectRoot, "src-tauri", "target", "release", "relax-eyes-desktop.exe"),
  path.join(projectRoot, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "relax-eyes-desktop.exe"),
].filter(Boolean);
const executable = executableCandidates.find((candidate) => fs.existsSync(candidate));
const outputRoot = path.join(projectRoot, "dist-tauri");
const outputExecutableBase = "Relax-Eyes-Tauri-Portable";

if (!executable) {
  throw new Error(`Tauri executable not found. Checked:\n${executableCandidates.join("\n")}`);
}

fs.mkdirSync(outputRoot, { recursive: true });
fs.mkdirSync(path.join(outputRoot, "data"), { recursive: true });
fs.mkdirSync(path.join(outputRoot, "scripts"), { recursive: true });
function copyToAvailableExecutable(source) {
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(outputRoot, `${outputExecutableBase}${suffix}.exe`);
    try {
      fs.copyFileSync(source, candidate);
      return candidate;
    } catch (error) {
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
    }
  }
  throw new Error(`Could not find a writable ${outputExecutableBase}.exe name in ${outputRoot}`);
}

const outputExecutable = copyToAvailableExecutable(executable);
for (const fileName of ["codex-pet-hook.cjs", "send-codex-event.cjs"]) {
  fs.copyFileSync(
    path.join(projectRoot, "scripts", fileName),
    path.join(outputRoot, "scripts", fileName),
  );
}
fs.writeFileSync(
  path.join(outputRoot, "README.txt"),
  [
    `Run ${path.basename(outputExecutable)}.`,
    "Runtime settings and the local Codex pet-agent endpoint are stored in the data folder.",
    "",
    "Optional Codex notifications:",
    "1. Start the pet and keep it running.",
    "2. Open Pet Settings from the pet context menu, switch to the Codex tab, and enable status notifications.",
    "Codex notifications appear as speech bubbles beside the pet; eye reminders use a separate window.",
    "3. In your user-level CODEX_HOME/hooks.json, merge PermissionRequest, PostToolUse, Stop, and SubagentStop hooks.",
    "4. Replace the hook command path with this folder's absolute path:",
    "   node \"<PET_DIR>\\scripts\\codex-pet-hook.cjs\"",
    "5. Run /hooks in Codex CLI and trust the changed hooks.",
    "PostToolUse command failures are held as internal candidates; only an unresolved main-turn failure that needs manual action becomes a red notification.",
    "The included Node scripts are only needed for Codex CLI hooks; the pet itself does not need npm.",
    "\r\n",
  ].join("\r\n"),
  "utf8",
);
console.log(`Created ${outputExecutable}`);
