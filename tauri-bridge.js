(function installRelaxEyesBridge() {
  if (window.relaxEyes || !window.__TAURI__) return;

  const tauri = window.__TAURI__;
  const invoke = tauri.core.invoke;
  const listen = tauri.event.listen;
  const appWindow = tauri.window.getCurrentWindow();

  const invokeSafe = (command, args) => invoke(command, args).catch((error) => {
    console.error(`Tauri command failed: ${command}`, error);
    throw error;
  });

  async function openContextMenu() {
    const [state, pets] = await Promise.all([
      invoke("get_state"),
      invoke("get_pet_catalog"),
    ]);
    const { Menu } = tauri.menu;
    const separator = { item: "Separator" };
    const currentPet = pets.find((pet) => pet.id === state.model) || pets[0];
    const actionNames = state.availableActions?.[state.model]?.length
      ? state.availableActions[state.model]
      : (currentPet?.baseAnimations || []);

    const item = (id, text, action, extra = {}) => ({
      id,
      text,
      action: () => invokeSafe(action.command, action.args),
      ...extra,
    });
    const submenu = (text, items) => ({ text, items });

    const modelItems = pets.map((pet) => item(
      `model:${pet.id}`,
      pet.label,
      { command: "change_model", args: { modelId: pet.id } },
      { checked: state.model === pet.id },
    ));
    const intervalItems = [20, 30, 45, 60].map((minutes) => item(
      `interval:${minutes}`,
      `${minutes} 分钟`,
      { command: "set_reminder_settings", args: { settings: { intervalMinutes: minutes } } },
      { checked: Math.round(Number(state.intervalMs) / 60000) === minutes },
    ));
    intervalItems.push(separator, item("interval:custom", "自定义...", { command: "open_size_panel" }));
    const restItems = [20, 30, 60, 120].map((seconds) => item(
      `rest:${seconds}`,
      `${seconds} 秒`,
      { command: "set_reminder_settings", args: { settings: { restSeconds: seconds } } },
      { checked: Math.round(Number(state.restDurationMs) / 1000) === seconds },
    ));
    restItems.push(separator, item("rest:custom", "自定义...", { command: "open_size_panel" }));
    const sizeItems = [
      [15, "极小 15%"],
      [20, "超小 20%"],
      [25, "小 25%"],
      [35, "默认 35%"],
      [55, "中 55%"],
      [68, "大 68%"],
      [100, "特大 100%"],
    ].map(([value, text]) => item(
      `size:${value}`,
      text,
      { command: "set_display_scale", args: { value: value / 100 } },
      { checked: Math.abs(Number(state.displayScale) - value / 100) < 0.001 },
    ));
    sizeItems.unshift(item("size:custom", "滑动调整...", { command: "open_size_panel" }), separator);
    const actionItems = actionNames.length
      ? actionNames.map((name) => item(
        `action:${name}`,
        name,
        { command: "play_animation", args: { name } },
      ))
      : [{ text: "动作加载中...", enabled: false }];

    const menu = await Menu.new({
      items: [
        { text: currentPet?.label || "桌面宠物", enabled: false },
        { text: state.phase === "due"
          ? "休息提醒已到"
          : state.paused
            ? "提醒已暂停"
            : `下次提醒：${formatRemaining(state.remainingMs)}`, enabled: false },
        separator,
        submenu("切换宠物", modelItems),
        submenu("提醒间隔", intervalItems),
        submenu("休息时长", restItems),
        item("reminder:edit", "编辑提醒文案...", { command: "open_size_panel" }),
        submenu("显示大小", sizeItems),
        submenu("动作", actionItems),
        item(
          "timer:pause",
          state.paused ? "恢复提醒" : "暂停提醒",
          { command: "toggle_pause" },
          { enabled: state.phase !== "due" },
        ),
        item("timer:reset", "立即重置计时", { command: "reset_timer", args: { source: "menu" } }),
        separator,
        item("app:quit", "退出", { command: "quit_app" }),
      ],
    });
    await menu.popup(undefined, appWindow);
  }

  function formatRemaining(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const seconds = (totalSeconds % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  window.relaxEyes = {
    getState: () => invoke("get_state"),
    beginDrag: () => invoke("begin_drag"),
    moveWindow: (x, y) => invokeSafe("move_window_command", { x, y }),
    endDrag: (x, y) => invokeSafe("end_drag", { x, y }),
    cancelDrag: () => invokeSafe("cancel_drag"),
    petClick: () => invokeSafe("pet_click"),
    openContextMenu,
    openSizePanel: () => invokeSafe("open_size_panel"),
    setDisplayScale: (value) => invokeSafe("set_display_scale", { value }),
    setReminderSettings: (settings) => invokeSafe("set_reminder_settings", { settings }),
    setContentInsets: (insets) => invokeSafe("set_content_insets", { insets }),
    setIgnoreMouseEvents: (ignored) => invokeSafe("set_ignore_mouse", { ignored }),
    confirmReminder: () => invokeSafe("confirm_reminder"),
    setAvailableAnimations: (modelId, names) => invokeSafe("set_model_actions", { modelId, names }),
    onState: (callback) => {
      let unlisten;
      listen("relax-eyes:state", (event) => callback(event.payload)).then((stop) => {
        unlisten = stop;
      });
      return () => unlisten?.();
    },
    onEvent: (callback) => {
      let unlisten;
      listen("relax-eyes:event", (event) => callback(event.payload)).then((stop) => {
        unlisten = stop;
      });
      return () => unlisten?.();
    },
  };
})();
