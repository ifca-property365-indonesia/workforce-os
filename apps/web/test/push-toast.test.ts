import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { approvalKeys, decidePush, pushKeys, RecentToasts, safePath } from "@/lib/push-toast";

describe("decidePush (a push the service worker offers to an open window)", () => {
  const push = (over: Record<string, unknown> = {}) => ({ type: "push" as const, title: "Approval needed", body: "Send invoice", url: "/approvals?focus=ap1", ...over });

  it("an unfocused window says no, so the system notification shows", () => {
    expect(decidePush(push(), false, new RecentToasts())).toEqual({ ack: false });
  });

  it("a focused window toasts with an Open link to the push's (same-origin) url and ACKs", () => {
    const d = decidePush(push(), true, new RecentToasts());
    expect(d).toEqual({ ack: true, toast: { id: "approval:ap1", title: "Approval needed", body: "Send invoice", url: "/approvals?focus=ap1" } });
    expect(decidePush(push({ url: "https://evil.example/x" }), true, new RecentToasts())).toMatchObject({ toast: { url: "/dashboard" } });
    expect(safePath("//evil.example")).toBe("/dashboard");
    expect(safePath("/\\evil.example")).toBe("/dashboard");
  });

  it("does not toast twice when the realtime approval.created toast already showed (either key)", () => {
    const now = 1_000_000;
    const recent = new RecentToasts();
    recent.mark(approvalKeys("ap1", "conv1"), "approval:ap1", now);
    expect(decidePush(push(), true, recent, now + 1000)).toEqual({ ack: true, toast: null });
    // a chat-raised approval links to the chat
    expect(decidePush(push({ url: "/chat?c=conv1&m=msg1" }), true, recent, now + 1000)).toEqual({ ack: true, toast: null });
    // other things still toast; and after the window the same thing can toast again
    expect(decidePush(push({ url: "/approvals?focus=ap2" }), true, recent, now + 1000)).toMatchObject({ toast: { id: "approval:ap2" } });
    expect(decidePush(push(), true, recent, now + 31_000)).toMatchObject({ toast: { id: "approval:ap1" } });
  });

  it("the second of two identical pushes is not toasted again; the tag wins as the key", () => {
    const recent = new RecentToasts();
    expect(decidePush(push({ tag: "t1" }), true, recent)).toMatchObject({ toast: { id: "tag:t1" } });
    expect(decidePush(push({ tag: "t1", url: "/tasks/1" }), true, recent)).toEqual({ ack: true, toast: null });
    expect(pushKeys("/chat?c=c1&m=m1", "x")).toEqual(["tag:x", "chat:c1"]);
  });

  it("a push without a title is left to the system notification", () => {
    expect(decidePush(push({ title: "" }), true, new RecentToasts())).toEqual({ ack: false });
  });
});

/** Run public/sw.js against a stand-in `self` and fire a push at it. */
function loadWorker(clients: { focused?: boolean; visibilityState?: string; postMessage: (msg: unknown, ports: MessagePort[]) => void }[]) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const showNotification = vi.fn(async () => {});
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => void (handlers[type] = fn),
    clients: { matchAll: async () => clients, claim: async () => {} },
    registration: { showNotification },
    skipWaiting: () => {},
    location: { origin: "http://localhost:3010" },
  };
  const src = readFileSync(path.resolve(import.meta.dirname, "../public/sw.js"), "utf8");
  vm.runInNewContext(src, { self, caches: {}, fetch, MessageChannel, setTimeout, clearTimeout, URL, Promise });
  return {
    showNotification,
    async push(payload: Record<string, unknown>) {
      let done: Promise<unknown> = Promise.resolve();
      handlers.push!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => void (done = p) });
      await done;
    },
  };
}

describe("public/sw.js push handling", () => {
  const payload = { title: "Approval needed", body: "Send invoice", url: "/approvals?focus=ap1" };

  it("suppresses the system notification only when a focused window ACKs", async () => {
    const seen: unknown[] = [];
    const sw = loadWorker([{ focused: true, visibilityState: "visible", postMessage: (msg, [port]) => (seen.push(msg), port!.postMessage({ ack: true })) }]);
    await sw.push(payload);
    expect(seen).toEqual([{ type: "push", title: "Approval needed", body: "Send invoice", url: "/approvals?focus=ap1", tag: undefined }]);
    expect(sw.showNotification).not.toHaveBeenCalled();
  });

  it("shows it when the window says no, or does not answer within the timeout", async () => {
    const no = loadWorker([{ focused: false, visibilityState: "visible", postMessage: (_m, [port]) => port!.postMessage({ ack: false }) }]);
    await no.push(payload);
    expect(no.showNotification).toHaveBeenCalledWith("Approval needed", expect.objectContaining({ body: "Send invoice", data: { url: "/approvals?focus=ap1" } }));

    const silent = loadWorker([{ focused: true, visibilityState: "visible", postMessage: () => {} }]);
    const t0 = Date.now();
    await silent.push(payload);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
    expect(silent.showNotification).toHaveBeenCalledTimes(1);
  });

  it("shows it straight away when no window is visible, and never links off-site", async () => {
    const sw = loadWorker([{ focused: false, visibilityState: "hidden", postMessage: () => {} }]);
    await sw.push({ ...payload, url: "//evil.example" });
    expect(sw.showNotification).toHaveBeenCalledWith("Approval needed", expect.objectContaining({ data: { url: "/dashboard" } }));
  });
});
