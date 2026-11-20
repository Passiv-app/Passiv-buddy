// The quick typing box: it can say "open", send back what was typed, and close. Nothing else.
const { contextBridge, ipcRenderer } = require("electron");

const arg = process.argv.find((a) => a.startsWith("--passiv-origin="));
const ours = !!arg && location.origin === arg.slice("--passiv-origin=".length) && window.top === window;

if (ours) {
  contextBridge.exposeInMainWorld("askBox", {
    platform: process.platform,
    onOpen: (fn) => ipcRenderer.on("ask:open", () => fn()),
    submit: (text) => { if (typeof text === "string") ipcRenderer.send("ask:submit", text.slice(0, 2000)); },
    close: () => ipcRenderer.send("ask:close"),
  });
}
