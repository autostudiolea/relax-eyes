const crypto = require("node:crypto");
const path = require("node:path");

const { findEndpointPath, postEvent } = require("./send-codex-event.cjs");

const MAX_TEXT_LENGTH = 240;

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function cleanText(value, fallback, maximumLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? Array.from(text).slice(0, maximumLength).join("") : fallback;
}

function toolName(input) {
  return cleanText(input.tool_name, "Codex 工具", 80);
}

function projectName(input) {
  const cwd = cleanText(input.cwd, "Codex", 500);
  return cleanText(path.basename(cwd.replace(/[\\/]$/, "")), "Codex", 120);
}

function eventId(input, eventType) {
  const identity = JSON.stringify({
    eventType,
    hookEventName: input.hook_event_name,
    sessionId: input.session_id,
    turnId: input.turn_id,
    toolUseId: input.tool_use_id,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    permissionMode: input.permission_mode,
    transcriptPath: input.transcript_path,
    lastAssistantMessage: input.last_assistant_message,
    stopHookActive: input.stop_hook_active,
    approvalRequestId: input.approval_request_id
      || input.permission_request_id
      || input.request_id
      || input.id,
    source: input.source,
  });
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `codex-hook-${digest}`;
}

function baseEvent(input, eventType, status, title, summary, details = []) {
  return {
    protocol: "codex-pet/v1",
    event_id: eventId(input, eventType),
    event_type: eventType,
    status,
    title,
    summary,
    details,
    source: "codex-cli-hook",
    project: projectName(input),
    created_at: new Date().toISOString(),
  };
}

function toolDetails(input) {
  const description = cleanText(input.tool_input?.description, "", 240);
  return [
    { type: "tool", value: toolName(input) },
    ...(description ? [{ type: "description", value: description }] : []),
  ];
}

function hasToolFailure(response) {
  if (response == null) return false;
  if (typeof response === "string") {
    return false;
  }
  if (typeof response !== "object") return false;
  for (const key of ["is_error", "isError", "failed", "failure"]) {
    if (response[key] === true) return true;
  }
  for (const key of ["exit_code", "exitCode", "return_code", "returnCode"]) {
    const value = Number(response[key]);
    if (Number.isFinite(value) && value !== 0) return true;
  }
  const status = typeof response.status === "string" ? response.status.toLowerCase() : "";
  if (["error", "failed", "failure"].includes(status)) return true;
  return response.error != null && response.error !== false;
}

const FAILURE_STATUS_VALUES = new Set([
  "error",
  "failed",
  "failure",
  "fatal",
  "aborted",
  "cancelled",
  "canceled",
  "timeout",
  "timed_out",
  "timed-out",
  "upstream",
  "upstream_error",
  "network_error",
  "connection_error",
  "server_error",
]);

function failureText(value, depth = 0) {
  if (typeof value === "string") return cleanText(value, "", MAX_TEXT_LENGTH);
  if (!value || typeof value !== "object" || depth >= 2) return "";
  for (const key of ["message", "reason", "error", "failure", "detail", "output", "stderr", "text"]) {
    const text = failureText(value[key], depth + 1);
    if (text) return text;
  }
  return "";
}

function isFailureStatus(value) {
  if (typeof value !== "string") return false;
  const status = value.trim().toLowerCase().replace(/\s+/g, "_");
  return FAILURE_STATUS_VALUES.has(status);
}

function isFailureText(value) {
  const text = failureText(value);
  if (!text) return false;
  return [
    /^\s*(?:error|fatal|failure|failed)\b/i,
    /\b(?:upstream|api|network|connection|gateway|server|provider)\b.{0,60}\b(?:error|failure|failed|unavailable|timeout|timed[\s-]?out|reset|refused|aborted|disconnect(?:ed|ion)?)\b/i,
    /\b(?:request|operation|command|tool|turn)\b.{0,40}\b(?:failed|failure|error|timed[\s-]?out|aborted)\b/i,
    /\b(?:could not|unable to|cannot)\b.{0,50}\b(?:connect|reach|complete|send|receive|contact)\b/i,
    /\b(?:http|status)\s*[:=]?\s*[45]\d{2}\b/i,
    /\b(?:timed[\s-]?out|connection (?:reset|refused|closed)|remote (?:reset|closed))\b/i,
    /(?:上游|网络|连接|请求|接口|服务器|服务商).{0,30}(?:错误|失败|异常|超时|拒绝|重置|中断)/,
    /(?:错误|失败|异常|超时|拒绝|重置|中断)\s*[:：]/,
  ].some((pattern) => pattern.test(text));
}

function hasFailureValue(value) {
  return hasToolFailure(value) || isFailureText(value);
}

function hasFailureSignal(input) {
  for (const key of [
    "tool_response",
    "error",
    "failure",
    "failure_reason",
    "failureReason",
    "error_message",
    "errorMessage",
  ]) {
    if (hasFailureValue(input[key])) return true;
  }
  for (const key of ["status", "outcome", "result", "stop_reason", "stopReason"]) {
    if (isFailureStatus(input[key]) || isFailureText(input[key])) return true;
  }
  return isFailureText(input.last_assistant_message);
}

function failureReason(input) {
  for (const key of [
    "error",
    "failure",
    "failure_reason",
    "failureReason",
    "error_message",
    "errorMessage",
    "tool_response",
  ]) {
    const text = failureText(input[key]);
    if (text) return text;
  }
  for (const key of ["status", "outcome", "result", "stop_reason", "stopReason"]) {
    if (isFailureStatus(input[key])) return cleanText(input[key], "", MAX_TEXT_LENGTH);
  }
  const lastMessage = cleanText(input.last_assistant_message, "", MAX_TEXT_LENGTH);
  return isFailureText(lastMessage) ? lastMessage : "";
}

function eventForHook(input) {
  const hookEvent = input.hook_event_name;
  if (hookEvent === "PermissionRequest") {
    const tool = toolName(input);
    return baseEvent(
      input,
      "permission_request",
      "waiting_confirmation",
      "Codex 需要确认",
      `Codex 正在等待对 ${tool} 的确认。`,
      toolDetails(input),
    );
  }
  if (hookEvent === "PostToolUse" && hasFailureValue(input.tool_response)) {
    return baseEvent(
      input,
      "task_failed",
      "failed",
      "Codex 工具执行失败",
      `Codex 的 ${toolName(input)} 执行失败，请查看 Codex 输出。`,
      toolDetails(input),
    );
  }
  if (hookEvent === "Stop" || hookEvent === "SubagentStop") {
    const isSubagent = hookEvent === "SubagentStop";
    if (hasFailureSignal(input)) {
      const reason = failureReason(input);
      const details = reason ? [{ type: "reason", value: reason }] : [];
      if (isSubagent && input.agent_id) {
        details.push({ type: "agent", value: cleanText(input.agent_id, "Codex 子任务", 120) });
      }
      return baseEvent(
        input,
        "task_failed",
        "failed",
        isSubagent ? "Codex 子任务失败" : "Codex 工作失败",
        reason
          ? `${isSubagent ? "Codex 子任务检测到失败" : "Codex 检测到当前工作失败"}：${reason}`
          : (isSubagent ? "Codex 子任务未能正常完成。" : "Codex 未能正常完成当前工作。"),
        details,
      );
    }
    const lastMessage = cleanText(input.last_assistant_message, "", MAX_TEXT_LENGTH);
    return baseEvent(
      input,
      "task_completed",
      "completed",
      isSubagent ? "Codex 子任务完成" : "Codex 工作完成",
      lastMessage
        ? `${isSubagent ? "Codex 子任务已完成" : "Codex 已完成当前工作回合"}：${lastMessage}`
        : (isSubagent ? "Codex 已结束一个子任务。" : "Codex 已结束当前工作回合。"),
      isSubagent && input.agent_id
        ? [{ type: "agent", value: cleanText(input.agent_id, "Codex 子任务", 120) }]
        : [],
    );
  }
  return null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function deliverEvent(event, endpointPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await postEvent(event, endpointPath, { timeoutMs: 700 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await delay(70);
    }
  }
  throw lastError || new Error("Could not deliver Codex event");
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (!input || typeof input !== "object") return;

  const event = eventForHook(input);
  if (event) {
    try {
      const endpointPath = findEndpointPath({});
      await deliverEvent(event, endpointPath);
    } catch {
      // A missing pet must never block or alter a Codex turn.
    }
  }

  if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
    process.stdout.write(JSON.stringify({ continue: true }));
  }
}

if (require.main === module) {
  main().catch(() => {
    if (process.argv.includes("--stop")) process.stdout.write(JSON.stringify({ continue: true }));
  });
}

module.exports = {
  eventForHook,
  failureReason,
  hasFailureSignal,
};
