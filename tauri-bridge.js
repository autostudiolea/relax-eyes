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
    const visiblePetIds = Array.isArray(state.visiblePets) && state.visiblePets.length
      ? new Set(state.visiblePets)
      : null;
    const visiblePets = visiblePetIds
      ? pets.filter((pet) => visiblePetIds.has(pet.id))
      : pets;
    const currentPet = visiblePets.find((pet) => pet.id === state.model)
      || pets.find((pet) => pet.id === state.model)
      || visiblePets[0]
      || pets[0];
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

    const modelItems = visiblePets.map((pet) => item(
      `model:${pet.id}`,
      pet.label,
      { command: "change_model", args: { modelId: pet.id } },
      { checked: state.model === pet.id },
    ));
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
    const facingItems = [
      ["right", "向右"],
      ["left", "向左"],
    ].map(([facing, text]) => item(
      `facing:${facing}`,
      text,
      { command: "set_facing", args: { facing } },
      { checked: state.facing === facing },
    ));

    const menu = await Menu.new({
      items: [
        { text: currentPet?.label || "桌面宠物", enabled: false },
        { text: formatStatusText(state), enabled: false },
        separator,
        submenu("切换宠物", modelItems),
        submenu("宠物朝向", facingItems),
        item("pet:settings", "宠物设置", { command: "open_size_panel" }),
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

  function formatStatusText(state) {
    if (state.weeklyReportDueAt > 0) return "周报提醒已到";
    if (state.phase === "due") return "休息提醒已到";
    if (state.eyeBreakEnabled === false) return "休息提醒已关闭";
    if (state.paused) return "提醒已暂停";
    return `下次提醒：${formatRemaining(state.remainingMs)}`;
  }

  window.relaxEyes = {
    getState: () => invoke("get_state"),
    getPetCatalog: () => invoke("get_pet_catalog"),
    getWindowPosition: () => invoke("get_window_position"),
    beginDrag: () => invoke("begin_drag"),
    moveWindow: (x, y) => invokeSafe("move_window_command", { x, y }),
    endDrag: (x, y) => invokeSafe("end_drag", { x, y }),
    cancelDrag: () => invokeSafe("cancel_drag"),
    petClick: () => invokeSafe("pet_click"),
    ackCodexEvent: (eventId) => invokeSafe("ack_codex_event", { eventId }),
    openContextMenu,
    openSizePanel: () => invokeSafe("open_size_panel"),
    closeSizePanel: () => invokeSafe("close_size_panel"),
    setFacing: (facing) => invokeSafe("set_facing", { facing }),
    setDisplayScale: (value) => invokeSafe("set_display_scale", { value }),
    setReminderSettings: (settings) => invokeSafe("set_reminder_settings", { settings }),
    setVisiblePets: (visiblePets) => invokeSafe("set_visible_pets", { visiblePets }),
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
    onSettingsCloseRequested: (callback) => {
      let unlisten;
      listen("relax-eyes:settings-close-requested", () => callback()).then((stop) => {
        unlisten = stop;
      });
      return () => unlisten?.();
    },
  };
})();
