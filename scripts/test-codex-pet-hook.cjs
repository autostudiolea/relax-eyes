const assert = require("node:assert/strict");

const {
  eventForHook,
  terminalOutcome,
} = require("./codex-pet-hook.cjs");

function hookInput(overrides = {}) {
  return {
    session_id: "session-test",
    turn_id: "turn-test",
    cwd: "C:\\work\\demo",
    ...overrides,
  };
}

function eventType(input) {
  return eventForHook(hookInput(input))?.event_type;
}

assert.equal(
  eventType({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
  "permission_request",
);

const toolFailure = eventForHook(hookInput({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_response: { exit_code: 1, stderr: "command failed" },
}));
assert.equal(toolFailure.event_type, "tool_failure_candidate");
assert.equal(toolFailure.status, "observed");
assert.equal(toolFailure.visibility, "internal");

assert.equal(
  eventForHook(hookInput({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: "upstream error: connection reset by peer",
  })),
  null,
);

assert.equal(
  terminalOutcome(hookInput({
    hook_event_name: "Stop",
    last_assistant_message: "upstream error: connection reset by peer",
  })),
  "transient",
);

assert.equal(
  terminalOutcome(hookInput({
    hook_event_name: "Stop",
    last_assistant_message: "stream disconnected before completion: Upstream request failed",
  })),
  "failed_candidate",
);

assert.equal(
  terminalOutcome(hookInput({
    hook_event_name: "Stop",
    error: { message: "stream disconnected before completion: Upstream request failed" },
  })),
  "failed_candidate",
);

assert.equal(
  terminalOutcome(hookInput({
    hook_event_name: "Stop",
    status: "upstream_error",
  })),
  "transient",
);

assert.equal(
  terminalOutcome(hookInput({
    hook_event_name: "Stop",
    last_assistant_message: "I could not complete the change; please manually fix the failing command.",
  })),
  "manual_required",
);

assert.equal(
  terminalOutcome(hookInput({
    hook_event_name: "Stop",
    last_assistant_message: "The command failed with exit code 1 and remains unresolved.",
  })),
  "failed_candidate",
);

const completed = eventForHook(hookInput({
  hook_event_name: "Stop",
  last_assistant_message: "The command failed at first, but it was fixed and the tests passed.",
}));
assert.equal(completed.event_type, "turn_stop");
assert.equal(completed.terminal_outcome, "completed");
assert.equal(completed.visibility, "internal");

assert.equal(
  eventForHook(hookInput({
    hook_event_name: "SubagentStop",
    error: { message: "API request failed with HTTP 502" },
  })),
  null,
);

process.stdout.write("Codex hook classification tests passed.\n");
