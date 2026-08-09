const assert = require("node:assert/strict");

const { eventForHook } = require("./codex-pet-hook.cjs");

function statusPair(input) {
  const event = eventForHook(input);
  return [event?.event_type, event?.status];
}

assert.deepEqual(
  statusPair({
    hook_event_name: "Stop",
    last_assistant_message: "upstream error: connection reset by peer",
  }),
  ["task_failed", "failed"],
);

assert.deepEqual(
  statusPair({
    hook_event_name: "Stop",
    last_assistant_message: "Work completed successfully.",
  }),
  ["task_completed", "completed"],
);

assert.deepEqual(
  statusPair({
    hook_event_name: "SubagentStop",
    error: { message: "API request failed with HTTP 502" },
  }),
  ["task_failed", "failed"],
);

assert.deepEqual(
  statusPair({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: { exit_code: 1 },
  }),
  ["task_failed", "failed"],
);

assert.deepEqual(
  statusPair({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: "upstream error: connection reset by peer",
  }),
  ["task_failed", "failed"],
);

assert.deepEqual(
  statusPair({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
  ["permission_request", "waiting_confirmation"],
);

process.stdout.write("Codex hook event mapping tests passed.\n");
