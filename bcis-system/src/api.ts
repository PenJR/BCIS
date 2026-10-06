export type ApiResponse<T> = {
  success: boolean;
  message?: string;
  data?: T | null;
};

const API_BASE_URL = 'http://localhost:3000';

async function requestApi(path: string, options: RequestInit = {}): Promise<unknown> {
  if (window.bcisApi) {
    return window.bcisApi.request(path, options);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  return response.json();
}

export async function apiHealth(): Promise<unknown> {
  if (window.bcisApi) {
    return window.bcisApi.health();
  }

  const response = await fetch(`${API_BASE_URL}/api/health`);
  return response.json();
}

export async function apiRequest<T>(
  path: string,
  token?: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await requestApi(path, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (typeof response !== 'object' || response === null || !('success' in response)) {
    throw new Error('The BCIS API returned an invalid response.');
  }

  return response as ApiResponse<T>;
}

export function jsonBody(value: unknown): Pick<RequestInit, 'body' | 'method'> {
  return {
    method: 'POST',
    body: JSON.stringify(value),
  };
}
