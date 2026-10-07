"use client";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) location.href = "/login";
    const issues = (data as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    const msg = issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (data as { error?: string }).error;
    throw new ApiError(res.status, msg ?? `Request failed (${res.status})`, data);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => fetch(url, { cache: "no-store" }).then((r) => handle<T>(r)),
  post: <T>(url: string, body?: unknown) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => handle<T>(r)),
  put: <T>(url: string, body: unknown) =>
    fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => handle<T>(r)),
  patch: <T>(url: string, body: unknown) =>
    fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => handle<T>(r)),
  del: <T>(url: string) => fetch(url, { method: "DELETE" }).then((r) => handle<T>(r)),
  form: <T>(url: string, form: FormData) => fetch(url, { method: "POST", body: form }).then((r) => handle<T>(r)),
};
