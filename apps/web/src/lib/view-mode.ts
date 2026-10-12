/**
 * Desktop or classic layout, per device. The desktop needs a wide screen; below that the classic layout is the only
 * one. app/layout.tsx runs the same rule before paint (VIEW_SCRIPT) so the classic layout doesn't flash first.
 * Plain constants (no React) so the server layout can import VIEW_SCRIPT; the hook lives in use-view-mode.ts.
 */

export type ViewMode = "desktop" | "classic";
export const VIEW_KEY = "wfos-view";
export const DESKTOP_MIN_WIDTH = 1024;

/** inline in <head>: marks <html data-view> before the first paint */
export const VIEW_SCRIPT = `try{var v=localStorage.getItem('${VIEW_KEY}');document.documentElement.dataset.view=(v!=='classic'&&innerWidth>=${DESKTOP_MIN_WIDTH})?'desktop':'classic'}catch(e){}`;
