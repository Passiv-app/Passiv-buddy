// What the buddy's layer can do: hear Passiv's state and notes, and say where it can be clicked.
// The layer is loaded from Passiv (public/buddy/layer.html), so only that exact page gets this.
const { contextBridge, ipcRenderer } = require("electron");

const arg = process.argv.find((a) => a.startsWith("--passiv-origin="));
const ours = !!arg && location.origin === arg.slice("--passiv-origin=".length) && window.top === window;
const IN = ["overlay:state", "overlay:buddy", "overlay:todos", "overlay:notes", "overlay:reset"];

if (ours) {
  contextBridge.exposeInMainWorld("layer", {
    platform: process.platform,
    on: (channel, fn) => { if (IN.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data)); },
    interactive: (on) => ipcRenderer.send("overlay:interactive", !!on),
    command: (cmd) => ipcRenderer.send("overlay:command", cmd),
    ready: () => {},
  });
}
