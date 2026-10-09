// Fetch wrappers for the local API. Writes carry the header the server requires.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function handle<T>(res: Response): Promise<T> {
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText);
  return data as T;
}

export function get<T>(url: string): Promise<T> {
  return fetch(url).then((r) => handle<T>(r));
}

export function post<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  return fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-gmail-viewer": "1" },
    body: JSON.stringify(body),
  }).then((r) => handle<T>(r));
}

export const q = (params: Record<string, string | number>) =>
  "?" + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
