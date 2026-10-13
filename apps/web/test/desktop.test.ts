import { describe, expect, it } from "vitest";
import { isLocalHref, pathOf, routeOf } from "@/components/desktop/routes";
import { clampWin, type Win } from "@/components/desktop/geometry";

describe("desktop routes", () => {
  it("maps app paths to their window and page", () => {
    expect(routeOf("/approvals")).toMatchObject({ app: { key: "approvals" }, page: "approvals", detail: null, params: {} });
    expect(routeOf("/tasks/abc-123?tab=code")).toMatchObject({ app: { key: "tasks" }, page: "task", detail: "task", params: { id: "abc-123" } });
    expect(routeOf("/employees/hire")).toMatchObject({ app: { key: "employees" }, page: "hire", detail: "hire" });
    expect(routeOf("/employees/e1")).toMatchObject({ app: { key: "employees" }, page: "employee", params: { id: "e1" } });
    expect(routeOf("/chat?c=x")).toMatchObject({ app: { key: "chat" } });
    expect(routeOf("/outbox?focus=approval:a1")).toMatchObject({ app: { key: "outbox" }, page: "outbox", detail: null });
    expect(routeOf("/clients/c1")).toMatchObject({ app: { key: "clients" }, page: "client", detail: "client", params: { id: "c1" } });
  });

  it("leaves everything else to normal navigation", () => {
    expect(routeOf("/office")).toBeNull();
    expect(routeOf("/login")).toBeNull();
    expect(routeOf("https://example.com/tasks")).toBeNull();
    expect(routeOf("//evil.example/tasks")).toBeNull();
    expect(routeOf("tasks")).toBeNull();
    expect(routeOf("/tasks/a/b")).toBeNull();
  });

  it("never throws on a malformed escape", () => {
    expect(routeOf("/tasks/%E0%A4%A")).toBeNull();
  });

  it("only sends the browser to same-origin paths", () => {
    expect(isLocalHref("/login")).toBe(true);
    for (const bad of ["//evil.example", "/\\evil.example", "javascript:alert(1)", "https://evil.example", "login"]) expect(isLocalHref(bad)).toBe(false);
  });

  it("strips query, hash and trailing slashes from paths", () => {
    expect(pathOf("/tasks/?x=1#y")).toBe("/tasks");
    expect(pathOf("/")).toBe("/");
    expect(pathOf("mailto:a@b.c")).toBeNull();
  });
});

describe("window placement", () => {
  const insets = { top: 40, bottom: 96 };
  const win = (r: Partial<Win>): Win => ({ id: "w", history: ["/tasks"], at: 0, x: 100, y: 100, w: 900, h: 600, z: 1, min: false, max: false, ...r });

  it("keeps a window below the menu bar and above the dock", () => {
    const w = clampWin(win({ y: 0, h: 5000 }), 1440, 900, insets);
    expect(w.y).toBeGreaterThanOrEqual(insets.top);
    expect(w.h).toBeLessThanOrEqual(900 - insets.top - insets.bottom);
  });

  it("keeps enough of a window on screen to grab it", () => {
    const w = clampWin(win({ x: 5000 }), 1440, 900, insets);
    expect(w.x).toBeLessThanOrEqual(1440 - 160);
    const left = clampWin(win({ x: -5000 }), 1440, 900, insets);
    expect(left.x + left.w).toBeGreaterThanOrEqual(160);
  });

  it("never shrinks below the minimum size or past the screen", () => {
    expect(clampWin(win({ w: 10, h: 10 }), 1440, 900, insets)).toMatchObject({ w: 420, h: 300 });
    expect(clampWin(win({ w: 3000 }), 1280, 900, insets).w).toBe(1280 - 16);
  });

  it("leaves a maximized window alone", () => {
    const w = win({ max: true, x: -9999 });
    expect(clampWin(w, 1440, 900, insets)).toBe(w);
  });
});
