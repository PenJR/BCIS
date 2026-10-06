"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("bcisApi", {
  request: async (path, options = {}) => {
    const response = await fetch(`http://localhost:3000${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers ?? {}
      }
    });
    return response.json();
  },
  health: async () => {
    const response = await fetch("http://localhost:3000/api/health");
    return response.json();
  }
});
