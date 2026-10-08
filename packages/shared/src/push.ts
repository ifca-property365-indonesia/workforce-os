/**
 * Web Push endpoint policy. The worker POSTs to whatever endpoint a browser registered, so an endpoint is a URL a
 * user controls: only https URLs on the browser vendors' push services are accepted (fail closed), with no port,
 * credentials or IP-literal hosts. That keeps the worker from being pointed at internal addresses.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge (Chromium), Opera, Samsung
  "android.googleapis.com",
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari / iOS
];
const PUSH_SUFFIXES = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

export function pushEndpointAllowed(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return PUSH_HOSTS.includes(h) || PUSH_SUFFIXES.some((s) => h.endsWith(s) && h.length > s.length);
}

/** What the service worker receives. Only a title, a short body and an in-app path: no data beyond the notification. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export function pushPayload(subject: string, text: string, link?: string): PushPayload {
  const url = link && link.startsWith("/") && !link.startsWith("//") ? link : "/dashboard";
  return { title: subject.slice(0, 120), body: text.slice(0, 300), url };
}
