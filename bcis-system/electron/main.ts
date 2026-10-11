import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeConfigPath = path.join(app.getPath('userData'), 'bcis-config.json');

function readRuntimeConfig(): { apiBaseUrl?: string } {
  if (!existsSync(runtimeConfigPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(runtimeConfigPath, 'utf8')) as Partial<{ apiBaseUrl?: string }>;
    if (typeof parsed.apiBaseUrl === 'string' && parsed.apiBaseUrl.trim()) {
      return { apiBaseUrl: parsed.apiBaseUrl.trim().replace(/\/$/, '') };
    }
  } catch {
    return {};
  }

  return {};
}

process.env.APP_ROOT = path.join(__dirname, '..');
process.env.BCIS_API_BASE_URL ??= readRuntimeConfig().apiBaseUrl;

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST;

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    void win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    win = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(createWindow);
