import { describe, expect, it, vi } from "vitest";

const jar = { set: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => jar }));
const env = vi.hoisted(() => ({ serverEnv: { appUrl: "https://os.example.com" } }));
vi.mock("@/lib/server/env", () => env);

const { authCookieName, authCookieOptions, clearAuthCookie } = await import("@/lib/server/auth-cookies");

describe("sign-in cookies", () => {
  it("carry the __Host- prefix over https, so a sibling subdomain (an app preview) cannot plant one", async () => {
    expect(authCookieName("wfos_session")).toBe("__Host-wfos_session");
    expect(authCookieOptions(60)).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 60 });
    await clearAuthCookie("wfos_session");
    // expired with the same attributes: a browser ignores a __Host- cookie set without Secure / Path=/
    expect(jar.set).toHaveBeenCalledWith("__Host-wfos_session", "", { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 });
  });

  it("keep their plain names over http (local development)", () => {
    env.serverEnv.appUrl = "http://localhost:3011";
    expect(authCookieName("wfos_session")).toBe("wfos_session");
    expect(authCookieOptions(60).secure).toBe(false);
  });
});
