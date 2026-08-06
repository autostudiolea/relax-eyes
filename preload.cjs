const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relaxEyes", {
  getState: () => ipcRenderer.invoke("relax-eyes:get-state"),
  beginDrag: () => ipcRenderer.invoke("relax-eyes:begin-drag"),
  moveWindow: (x, y) => ipcRenderer.send("relax-eyes:move-window", { x, y }),
  endDrag: (x, y) => ipcRenderer.send("relax-eyes:end-drag", { x, y }),
  petClick: () => ipcRenderer.send("relax-eyes:pet-click"),
  openContextMenu: () => ipcRenderer.send("relax-eyes:open-context-menu"),
  openSizePanel: () => ipcRenderer.send("relax-eyes:open-size-panel"),
  setDisplayScale: (value) => ipcRenderer.send("relax-eyes:set-display-scale", value),
  setReminderSettings: (settings) => ipcRenderer.send("relax-eyes:set-reminder-settings", settings),
  setContentInsets: (insets) => ipcRenderer.send("relax-eyes:set-content-insets", insets),
  setIgnoreMouseEvents: (ignored) => ipcRenderer.send("relax-eyes:set-ignore-mouse", ignored),
  confirmReminder: () => ipcRenderer.send("relax-eyes:confirm-reminder"),
  setAvailableAnimations: (modelId, names) => ipcRenderer.send("relax-eyes:set-model-actions", { modelId, names }),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("relax-eyes:state", listener);
    return () => ipcRenderer.removeListener("relax-eyes:state", listener);
  },
  onEvent: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("relax-eyes:event", listener);
    return () => ipcRenderer.removeListener("relax-eyes:event", listener);
  },
});
