const range = document.getElementById("size-range");
const output = document.getElementById("size-value");
const intervalInput = document.getElementById("interval-minutes");
const restInput = document.getElementById("rest-seconds");
const titleInput = document.getElementById("reminder-title");
const bodyInput = document.getElementById("reminder-body");

function updateSettings(state) {
  const scale = Math.round(Number(state.displayScale || 0.35) * 100);
  range.value = String(Math.max(15, Math.min(100, scale)));
  output.textContent = `${range.value}%`;
  if (document.activeElement !== intervalInput) {
    intervalInput.value = String(Math.round(Number(state.intervalMs || 1200000) / 60000));
  }
  if (document.activeElement !== restInput) {
    restInput.value = String(Math.round(Number(state.restDurationMs || 20000) / 1000));
  }
  if (document.activeElement !== titleInput) titleInput.value = state.reminderTitle || "";
  if (document.activeElement !== bodyInput) bodyInput.value = state.reminderBody || "";
}

function sendReminderSettings() {
  window.relaxEyes.setReminderSettings({
    intervalMinutes: Number(intervalInput.value),
    restSeconds: Number(restInput.value),
    title: titleInput.value,
    body: bodyInput.value,
  });
}

range.addEventListener("input", () => {
  output.textContent = `${range.value}%`;
  window.relaxEyes.setDisplayScale(Number(range.value) / 100);
});

intervalInput.addEventListener("change", sendReminderSettings);
restInput.addEventListener("change", sendReminderSettings);
titleInput.addEventListener("change", sendReminderSettings);
bodyInput.addEventListener("change", sendReminderSettings);

window.relaxEyes.onState(updateSettings);
window.relaxEyes.getState().then(updateSettings);
