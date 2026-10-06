import { app as n, BrowserWindow as t } from "electron";
import { fileURLToPath as a } from "node:url";
import e from "node:path";
const r = e.dirname(a(import.meta.url));
process.env.APP_ROOT = e.join(r, "..");
const i = process.env.VITE_DEV_SERVER_URL, R = e.join(process.env.APP_ROOT, "dist-electron"), s = e.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = i ? e.join(process.env.APP_ROOT, "public") : s;
let o = null;
function l() {
  o = new t({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    autoHideMenuBar: !0,
    webPreferences: {
      preload: e.join(r, "preload.mjs"),
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !1
    }
  }), i ? o.loadURL(i) : o.loadFile(e.join(s, "index.html"));
}
n.on("window-all-closed", () => {
  process.platform !== "darwin" && (n.quit(), o = null);
});
n.on("activate", () => {
  t.getAllWindows().length === 0 && l();
});
n.whenReady().then(l);
export {
  R as MAIN_DIST,
  s as RENDERER_DIST,
  i as VITE_DEV_SERVER_URL
};
