import { app as n, BrowserWindow as a } from "electron";
import { existsSync as d, readFileSync as f } from "node:fs";
import { fileURLToPath as m } from "node:url";
import e from "node:path";
const l = e.dirname(m(import.meta.url)), r = e.join(n.getPath("userData"), "bcis-config.json");
function u() {
  if (!d(r))
    return {};
  try {
    const o = JSON.parse(f(r, "utf8"));
    if (typeof o.apiBaseUrl == "string" && o.apiBaseUrl.trim())
      return { apiBaseUrl: o.apiBaseUrl.trim().replace(/\/$/, "") };
  } catch {
    return {};
  }
  return {};
}
process.env.APP_ROOT = e.join(l, "..");
var s;
(s = process.env).BCIS_API_BASE_URL ?? (s.BCIS_API_BASE_URL = u().apiBaseUrl);
const t = process.env.VITE_DEV_SERVER_URL, E = e.join(process.env.APP_ROOT, "dist-electron"), c = e.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = t ? e.join(process.env.APP_ROOT, "public") : c;
let i = null;
function p() {
  i = new a({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    autoHideMenuBar: !0,
    webPreferences: {
      preload: e.join(l, "preload.cjs"),
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !1
    }
  }), t ? i.loadURL(t) : i.loadFile(e.join(c, "index.html"));
}
n.on("window-all-closed", () => {
  process.platform !== "darwin" && (n.quit(), i = null);
});
n.on("activate", () => {
  a.getAllWindows().length === 0 && p();
});
n.whenReady().then(p);
export {
  E as MAIN_DIST,
  c as RENDERER_DIST,
  t as VITE_DEV_SERVER_URL
};
