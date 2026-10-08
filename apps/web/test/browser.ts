import { vi } from "vitest";
import { NextRequest } from "next/server";

/** Minimal stand-in for next/headers' cookie store: one browser per test file. */
const store = new Map<string, string>();
export const jar = {
  get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
  getAll: () => [...store].map(([name, value]) => ({ name, value })),
  has: (name: string) => store.has(name),
  set: (name: string, value: string) => void store.set(name, value),
  delete: (name: string) => void store.delete(name),
  clear: () => store.clear(),
};

const counters = new Map<string, number>();
export const kv = new Map<string, string>();
export const redisState = { down: false };
export const queueModule = {
  redis: () => ({
    ping: async () => {
      if (redisState.down) throw new Error("connect ECONNREFUSED 10.0.0.5:6379");
      return "PONG";
    },
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => (kv.set(k, v), "OK"),
    incr: async (k: string) => {
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      return n;
    },
    expire: async () => 1,
    del: async (k: string) => void counters.delete(k),
    publish: async () => 0,
  }),
  q: { task: vi.fn(), chat: vi.fn(), action: vi.fn(), ingest: vi.fn(), misc: vi.fn() },
  publish: vi.fn(async () => {}),
  control: vi.fn(async () => {}),
};

export function resetBrowser() {
  store.clear();
  counters.clear();
  kv.clear();
  redisState.down = false;
}

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function call(handler: unknown, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return callWithParams(handler, method, path, body, {});
}

export async function callWithParams(
  handler: unknown,
  method: string,
  path: string,
  body: unknown,
  params: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new NextRequest(`http://localhost:3010${path}`, {
    method,
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}
