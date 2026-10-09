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

/** Only for responses without a JSON error body (proxy errors, network failures). */
function fallbackMessage(status: number): string {
  const lang = typeof document !== "undefined" ? document.documentElement.lang : "en";
  // i18n-ignore: rendered before any catalog is available for this response
  return lang === "id" ? `Permintaan gagal (${status}).` : `Request failed (${status}).`;
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    // step_up_required is also a 401 but the session is fine: <StepUpProvider> asks for password + 2FA instead
    const code = (data as { code?: string }).code;
    if (res.status === 401 && code !== "step_up_required" && typeof window !== "undefined" && !location.pathname.startsWith("/login")) location.href = "/login";
    // the server sends `error` already translated into the user's language
    throw new ApiError(res.status, (data as { error?: string }).error ?? fallbackMessage(res.status), data);
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
  del: <T>(url: string, body?: unknown) =>
    fetch(url, body === undefined ? { method: "DELETE" } : { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => handle<T>(r)),
  form: <T>(url: string, form: FormData) => fetch(url, { method: "POST", body: form }).then((r) => handle<T>(r)),
};
