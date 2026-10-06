export type ApiResponse<T> = {
  success: boolean;
  message?: string;
  data?: T | null;
};

export async function apiRequest<T>(
  path: string,
  token?: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  if (!window.bcisApi) {
    throw new Error('The BCIS Electron API bridge is unavailable.');
  }

  const response = await window.bcisApi.request(path, {
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
