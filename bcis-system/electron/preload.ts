import { contextBridge } from 'electron';

const apiBaseUrl = (process.env.BCIS_API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

contextBridge.exposeInMainWorld('bcisRuntimeConfig', {
  apiBaseUrl,
});

contextBridge.exposeInMainWorld('bcisApi', {
  request: async (path: string, options: RequestInit = {}) => {
    try {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
      });
      const body: unknown = await response.json();
      if (!response.ok && typeof body === 'object' && body !== null && 'success' in body) {
        return body;
      }
      return body;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to reach the BCIS API.';
      throw new Error(`BCIS API request failed: ${message}`);
    }
  },
  health: async () => {
    const response = await fetch(`${apiBaseUrl}/api/health`);
    return response.json();
  },
});

declare global {
  interface Window {
    bcisRuntimeConfig?: {
      apiBaseUrl: string;
    };
    bcisApi?: {
      request: (path: string, options?: RequestInit) => Promise<unknown>;
      health: () => Promise<unknown>;
    };
  }
}
