const DEFAULT_TITLE = "\u8be5\u653e\u677e\u4e00\u4e0b\u773c\u775b\u4e86";
const DEFAULT_BODY = "\u770b\u5411\u8fdc\u5904 {seconds} \u79d2\uff0c\u6216\u8005\u70b9\u51fb\u5ba0\u7269\u786e\u8ba4\u5df2\u7ecf\u4f11\u606f\u3002";
const DEFAULT_WEEKLY_TITLE = "\u8be5\u5199\u5468\u62a5\u4e86";
const DEFAULT_WEEKLY_BODY = "\u82b1\u51e0\u5206\u949f\u56de\u987e\u672c\u5468\u5b8c\u6210\u7684\u5de5\u4f5c\u548c\u4e0b\u5468\u8ba1\u5212\u3002";
const EYE_KICKER = "\u773c\u775b\u4f11\u606f";
const WEEKLY_KICKER = "\u5468\u62a5\u63d0\u9192";
const CONTINUE_LABEL = "\u5df2\u4f11\u606f\uff0c\u7ee7\u7eed\u5de5\u4f5c";
const WEEKLY_LABEL = "\u5b8c\u6210\u540e\u7ee7\u7eed\u5de5\u4f5c";
const kicker = document.getElementById("reminder-kicker");
const title = document.getElementById("reminder-title");
const body = document.getElementById("reminder-body");
const rest = document.getElementById("reminder-rest");
const confirmButton = document.getElementById("reminder-confirm");
const confirmLabel = document.getElementById("reminder-confirm-label");

function hexToRgba(value, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || ""));
  if (!match) return `rgba(255, 156, 96, ${alpha})`;
  const color = Number.parseInt(match[1], 16);
  return `rgba(${color >> 16}, ${(color >> 8) & 255}, ${color & 255}, ${alpha})`;
}

function updateReminder(state) {
  if (!state) return;
  const type = state.notificationType
    || (state.weeklyReportDueAt > 0 ? "weekly" : "eye");
  const weekly = type === "weekly";
  const accent = state.notificationAccent || (weekly ? "#e5484d" : "#ff9c60");
  document.documentElement.style.setProperty("--reminder-accent", accent);
  document.documentElement.style.setProperty("--reminder-accent-soft", hexToRgba(accent, 0.8));
  document.documentElement.style.setProperty("--reminder-accent-background", hexToRgba(accent, 0.2));
  const seconds = Math.max(1, Math.round(Number(state.restDurationMs || 20000) / 1000));
  const reminderBody = (weekly ? state.weeklyReportBody || DEFAULT_WEEKLY_BODY : state.reminderBody || DEFAULT_BODY)
    .replaceAll("{seconds}", String(seconds))
    .replaceAll("{restSeconds}", String(seconds));
  kicker.textContent = weekly ? WEEKLY_KICKER : EYE_KICKER;
  title.textContent = weekly ? state.weeklyReportTitle || DEFAULT_WEEKLY_TITLE : state.reminderTitle || DEFAULT_TITLE;
  body.textContent = reminderBody;
  rest.textContent = weekly ? "整理本周工作" : `\u81f3\u5c11\u4f11\u606f ${seconds} \u79d2`;
  confirmLabel.textContent = weekly ? WEEKLY_LABEL : CONTINUE_LABEL;
}

confirmButton.addEventListener("click", () => window.relaxEyes.confirmReminder());
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === "Escape") window.relaxEyes.confirmReminder();
});

window.relaxEyes.onState(updateReminder);
window.relaxEyes.getState().then(updateReminder).catch(() => {});
