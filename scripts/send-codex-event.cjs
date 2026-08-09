const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

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
    } else {
      options[key] = true;
    }
  }
  return options;
}

function defaultStatus(eventType) {
  return {
    permission_request: "waiting_confirmation",
    task_started: "started",
    task_completed: "completed",
    task_failed: "failed",
  }[eventType] || "completed";
}

function defaultTitle(status) {
  return {
    waiting_confirmation: "Codex 需要确认",
    started: "Codex 开始工作",
    completed: "Codex 工作完成",
    failed: "Codex 工作失败",
  }[status] || "Codex 状态更新";
}

function readEvent(options) {
  if (typeof options["event-file"] === "string") {
    return JSON.parse(fs.readFileSync(path.resolve(options["event-file"]), "utf8"));
  }
  const eventType = typeof options.type === "string" ? options.type : "task_completed";
  const status = typeof options.status === "string" ? options.status : defaultStatus(eventType);
  return {
    protocol: "codex-pet/v1",
    event_id: typeof options["event-id"] === "string"
      ? options["event-id"]
      : `manual-${Date.now()}-${process.pid}`,
    event_type: eventType,
    status,
    title: typeof options.title === "string" ? options.title : defaultTitle(status),
    summary: typeof options.summary === "string" ? options.summary : "这是一个本地 Codex 合成事件。",
    details: [],
    source: "codex-test",
    project: typeof options.project === "string" ? options.project : path.basename(projectRoot),
    created_at: new Date().toISOString(),
  };
}

function findEndpointPath(options) {
  if (typeof options.endpoint === "string") {
    return path.resolve(options.endpoint);
  }
  const localEndpoint = path.join(projectRoot, "data", "codex-pet-endpoint.json");
  if (fs.existsSync(localEndpoint)) return localEndpoint;
  const candidates = [
    path.join(projectRoot, "dist-tauri", "data", "codex-pet-endpoint.json"),
    path.join(projectRoot, "src-tauri", "target", "debug", "data", "codex-pet-endpoint.json"),
    path.join(projectRoot, "src-tauri", "target", "release", "data", "codex-pet-endpoint.json"),
    path.join(projectRoot, "src-tauri", "target", "x86_64-pc-windows-msvc", "debug", "data", "codex-pet-endpoint.json"),
    path.join(projectRoot, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "data", "codex-pet-endpoint.json"),
  ];
  const existing = candidates
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  if (!existing.length) {
    throw new Error("Could not find codex-pet-endpoint.json; start the Tauri app first or pass --endpoint");
  }
  return existing[0];
}

function readEndpoint(endpointPath) {
  const endpoint = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
  if (endpoint.protocol !== "codex-pet/v1" || endpoint.host !== "127.0.0.1") {
    throw new Error("Invalid local Codex pet-agent endpoint");
  }
  if (!Number.isInteger(endpoint.port) || typeof endpoint.token !== "string" || !endpoint.token) {
    throw new Error("Invalid local Codex pet-agent endpoint fields");
  }
  return endpoint;
}

function postEvent(event, endpointPath = findEndpointPath({}), options = {}) {
  const endpoint = readEndpoint(endpointPath);
  const body = Buffer.from(JSON.stringify(event), "utf8");
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(100, Number(options.timeoutMs))
    : 2000;
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: endpoint.host,
      port: endpoint.port,
      path: "/v1/events",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "X-Codex-Pet-Token": endpoint.token,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const result = {
          statusCode: response.statusCode || 0,
          text: Buffer.concat(chunks).toString("utf8"),
        };
        if (result.statusCode < 200 || result.statusCode >= 300) {
          reject(new Error(`Codex pet-agent returned HTTP ${result.statusCode}`));
          return;
        }
        resolve(result);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Local Codex pet-agent request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const endpointPath = findEndpointPath(options);
  const event = readEvent(options);
  const response = await postEvent(event, endpointPath);
  process.stdout.write(`${response.statusCode} ${response.text}\n`);
  process.exitCode = response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  findEndpointPath,
  postEvent,
};
