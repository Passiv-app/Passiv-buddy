// The bridge Passiv's buddy window sees as window.passivDesktop. Only Passiv's own page gets it: the exact address
// the app was started with (passed in by the main process), served over https, in the page itself and not in a frame.
const { contextBridge, ipcRenderer } = require("electron");

const arg = process.argv.find((a) => a.startsWith("--passiv-origin="));
const ours = !!arg && location.origin === arg.slice("--passiv-origin=".length) && window.top === window;
const OUT = new Set(["state", "buddy", "todos", "notes", "show", "hide", "ready", "onboarded"]);
const ASK = new Set(["info", "permissions", "openPermission", "openExternal", "setLogin", "retryKeys", "installUpdate"]);

if (ours) {
  contextBridge.exposeInMainWorld("passivDesktop", {
    platform: process.platform,
    send: (channel, data) => { if (OUT.has(channel)) ipcRenderer.send(`app:${channel}`, data); },
    invoke: (name, arg2) => (ASK.has(name) ? ipcRenderer.invoke("desktop:invoke", name, arg2) : Promise.resolve(null)),
    // Returns a function that stops listening.
    on: (fn) => {
      const h = (_e, cmd) => { try { fn(cmd); } catch { /* the page handles its own errors */ } };
      ipcRenderer.on("desktop:command", h);
      return () => ipcRenderer.removeListener("desktop:command", h);
    },
  });
}
