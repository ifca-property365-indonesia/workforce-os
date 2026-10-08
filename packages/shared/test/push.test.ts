import { describe, expect, it } from "vitest";
import { pushEndpointAllowed, pushPayload } from "../src/push";

describe("push endpoint policy", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
    "https://web.push.apple.com/QGx",
    "https://wns2-db5p.notify.windows.com/w/?token=x",
  ])("accepts %s", (u) => expect(pushEndpointAllowed(u)).toBe(true));

  it.each([
    "http://fcm.googleapis.com/fcm/send/x", // not https
    "https://fcm.googleapis.com:8443/fcm/send/x", // port
    "https://user:pw@fcm.googleapis.com/x", // credentials
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://localhost/x",
    "https://evil.example/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.example/x", // suffix trick
    "https://notify.windows.com/x", // bare suffix
    "https://evilpush.apple.com/x",
    "file:///etc/passwd",
    "not a url",
  ])("refuses %s", (u) => expect(pushEndpointAllowed(u)).toBe(false));

  it("payload links stay inside the app", () => {
    expect(pushPayload("s", "t", "/tasks/1").url).toBe("/tasks/1");
    expect(pushPayload("s", "t", "https://evil.example").url).toBe("/dashboard");
    expect(pushPayload("s", "t", "//evil.example").url).toBe("/dashboard");
    expect(pushPayload("x".repeat(500), "y".repeat(500)).title).toHaveLength(120);
  });
});
