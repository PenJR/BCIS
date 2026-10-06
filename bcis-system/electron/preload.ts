import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('bcisApi', {
  request: async (path: string, options: RequestInit = {}) => {
    const response = await fetch(`http://localhost:3000${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });

    return response.json();
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
