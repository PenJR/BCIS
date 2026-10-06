"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("bcisApi", {
  request: async (path, options = {}) => {
    try {
      const response = await fetch(`http://localhost:3000${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers ?? {}
        }
      });
      const body = await response.json();
      if (!response.ok && typeof body === "object" && body !== null && "success" in body) {
        return body;
      }
      return body;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to reach the BCIS API.";
      throw new Error(`BCIS API request failed: ${message}`);
    }
  },
  health: async () => {
    const response = await fetch("http://localhost:3000/api/health");
    return response.json();
  }
});
