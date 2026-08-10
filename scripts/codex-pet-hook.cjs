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
  const sessionId = cleanText(input.session_id, "", 160);
  const turnId = cleanText(input.turn_id, "", 160);
  const agentId = cleanText(input.agent_id, "", 120);
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
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(turnId ? { turn_id: turnId } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
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
const TRANSIENT_STATUS_VALUES = new Set([
  "upstream",
  "upstream_error",
  "network_error",
  "connection_error",
  "server_error",
  "timeout",
  "timed_out",
  "timed-out",
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

function isTransientStatus(value) {
  if (typeof value !== "string") return false;
  return TRANSIENT_STATUS_VALUES.has(value.trim().toLowerCase().replace(/\s+/g, "_"));
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
  return lastMessage;
}

function hasExplicitManualSignal(input) {
  for (const key of [
    "requires_manual_action",
    "requiresManualAction",
    "needs_user_action",
    "needsUserAction",
    "manual_intervention_required",
    "manualInterventionRequired",
  ]) {
    if (input[key] === true) return true;
  }
  const text = cleanText(input.last_assistant_message, "", MAX_TEXT_LENGTH);
  if (!text) return false;
  return [
    /\b(?:manual(?:ly)?|you need to|requires? you to|user action|required action)\b.{0,80}\b(?:retry|run|fix|resolve|check|handle|restart|approve|configure|intervene)\b/i,
    /\b(?:please)\b.{0,80}\b(?:retry|run|fix|resolve|check|handle|restart|approve|configure|intervene)\b/i,
    /(?:需要你|请你|需手动|手动|人工).{0,36}(?:重试|运行|修复|解决|检查|处理|重启|确认|配置|干预)/,
  ].some((pattern) => pattern.test(text));
}

function hasTransientFailureSignal(input) {
  if (["status", "outcome", "result", "stop_reason", "stopReason"]
    .some((key) => isTransientStatus(input[key]))) {
    return true;
  }
  const text = [
    input.last_assistant_message,
    input.error,
    input.failure,
    input.error_message,
    input.errorMessage,
    input.stop_reason,
    input.stopReason,
  ]
    .map((value) => failureText(value))
    .filter(Boolean)
    .join(" ");
  if (!text) return false;
  return [
    /\b(?:upstream|network|connection|gateway|provider|server)\b.{0,60}\b(?:error|failure|failed|unavailable|timeout|timed[\s-]?out|reset|refused|aborted|disconnect(?:ed|ion)?)\b/i,
    /\b(?:http|status)\s*[:=]?\s*5\d{2}\b/i,
    /\b(?:timed[\s-]?out|connection (?:reset|refused|closed)|remote (?:reset|closed))\b/i,
    /(?:上游|网络|连接|服务器|服务商).{0,30}(?:错误|失败|异常|超时|拒绝|重置|中断)/,
  ].some((pattern) => pattern.test(text));
}

function hasTerminalStreamFailureSignal(input) {
  const text = [
    input.last_assistant_message,
    input.error,
    input.failure,
    input.error_message,
    input.errorMessage,
    input.stop_reason,
    input.stopReason,
  ]
    .map((value) => failureText(value))
    .filter(Boolean)
    .join(" ");
  return [
    /\bstream\s+disconnected\b.{0,80}\bbefore\s+completion\b/i,
    /\b(?:upstream|provider|server)\s+request\s+failed\b/i,
  ].some((pattern) => pattern.test(text));
}

function hasResolutionSignal(input) {
  const text = cleanText(input.last_assistant_message, "", MAX_TEXT_LENGTH);
  if (!text) return false;
  if (/\b(?:not|never|didn't|did not|couldn't|could not|unable to)\b.{0,30}\b(?:resolve|fix|complete|pass|finish)\b/i.test(text)) {
    return false;
  }
  return [
    /\b(?:completed successfully|successfully completed|fixed|resolved|tests? passed|passed successfully|done)\b/i,
    /(?:已完成|已修复|已解决|测试通过|处理好了|完成了)/,
  ].some((pattern) => pattern.test(text));
}

function hasUnresolvedFailureSignal(input) {
  const text = cleanText(input.last_assistant_message, "", MAX_TEXT_LENGTH);
  const statusFailure = ["failed", "failure", "fatal", "aborted", "cancelled", "canceled"]
    .some((value) => input.status === value || input.outcome === value);
  if (statusFailure) return true;
  if (!text || hasResolutionSignal(input)) return false;
  return [
    /\b(?:could not|couldn't|unable to|cannot|can't|failed to|was unable to|did not complete|didn't complete|stopped)\b.{0,100}\b(?:complete|continue|finish|resolve|fix|apply|run|execute|deliver)\b/i,
    /\b(?:task|turn|command|tool|operation|request|tests?)\b.{0,35}\b(?:failed|failure|error|timed[\s-]?out|aborted|cancelled|canceled)\b/i,
    /\b(?:not|never)\s+(?:completed|fixed|resolved|applied|passed)\b/i,
    /(?:无法|未能|没能|不能).{0,40}(?:完成|继续|解决|修复|应用|执行)/,
    /(?:任务|回合|命令|工具|操作|请求|测试).{0,24}(?:失败|错误|超时|中止|取消)/,
  ].some((pattern) => pattern.test(text));
}

function terminalOutcome(input) {
  if (hasExplicitManualSignal(input)) return "manual_required";
  if (hasResolutionSignal(input)) return "completed";
  if (hasTerminalStreamFailureSignal(input)) return "failed_candidate";
  if (hasUnresolvedFailureSignal(input)) return "failed_candidate";
  if (hasTransientFailureSignal(input)) return "transient";
  return "completed";
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
  if (hookEvent === "PostToolUse" && hasToolFailure(input.tool_response)) {
    const reason = failureReason(input);
    const details = [
      ...toolDetails(input),
      ...(reason ? [{ type: "reason", value: reason }] : []),
    ];
    return {
      ...baseEvent(
        input,
        "tool_failure_candidate",
        "observed",
        "Codex 工具失败候选",
        `Codex 记录到 ${toolName(input)} 的一次失败，等待当前回合最终结果。`,
        details,
      ),
      visibility: "internal",
      failure_reason: reason,
    };
  }
  if (hookEvent === "Stop") {
    const outcome = terminalOutcome(input);
    const reason = outcome === "failed_candidate" || outcome === "manual_required"
      ? failureReason(input)
      : "";
    return {
      ...baseEvent(
        input,
        "turn_stop",
        "observed",
        "Codex 回合结束",
        cleanText(input.last_assistant_message, "Codex 已结束当前工作回合。", MAX_TEXT_LENGTH),
        reason ? [{ type: "reason", value: reason }] : [],
      ),
      visibility: "internal",
      terminal_outcome: outcome,
      failure_reason: reason,
    };
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
  hasExplicitManualSignal,
  hasTerminalStreamFailureSignal,
  hasTransientFailureSignal,
  hasUnresolvedFailureSignal,
  terminalOutcome,
};
