const DEFAULT_TITLE = "\u8be5\u653e\u677e\u4e00\u4e0b\u773c\u775b\u4e86";
const DEFAULT_BODY = "\u770b\u5411\u8fdc\u5904 {seconds} \u79d2\uff0c\u6216\u8005\u70b9\u51fb\u5ba0\u7269\u786e\u8ba4\u5df2\u7ecf\u4f11\u606f\u3002";
const KICKER = "\u773c\u775b\u4f11\u606f";
const CONTINUE_LABEL = "\u5df2\u4f11\u606f\uff0c\u7ee7\u7eed\u5de5\u4f5c";

const kicker = document.getElementById("reminder-kicker");
const title = document.getElementById("reminder-title");
const body = document.getElementById("reminder-body");
const rest = document.getElementById("reminder-rest");
const confirmButton = document.getElementById("reminder-confirm");
const confirmLabel = document.getElementById("reminder-confirm-label");

function updateReminder(state) {
  if (!state) return;
  const seconds = Math.max(1, Math.round(Number(state.restDurationMs || 20000) / 1000));
  const reminderBody = (state.reminderBody || DEFAULT_BODY)
    .replaceAll("{seconds}", String(seconds))
    .replaceAll("{restSeconds}", String(seconds));
  kicker.textContent = KICKER;
  title.textContent = state.reminderTitle || DEFAULT_TITLE;
  body.textContent = reminderBody;
  rest.textContent = `\u81f3\u5c11\u4f11\u606f ${seconds} \u79d2`;
  confirmLabel.textContent = CONTINUE_LABEL;
}

confirmButton.addEventListener("click", () => window.relaxEyes.confirmReminder());
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === "Escape") window.relaxEyes.confirmReminder();
});

window.relaxEyes.onState(updateReminder);
window.relaxEyes.getState().then(updateReminder).catch(() => {});
