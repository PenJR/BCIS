import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('bcisApi', {
  request: async (path: string, options: RequestInit = {}) => {
    try {
      const response = await fetch(`http://localhost:3000${path}`, {
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
    const response = await fetch('http://localhost:3000/api/health');
    return response.json();
  },
});

declare global {
  interface Window {
    bcisApi: {
      request: (path: string, options?: RequestInit) => Promise<unknown>;
      health: () => Promise<unknown>;
    };
  }
}
