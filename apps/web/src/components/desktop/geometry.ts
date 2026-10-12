/** Window geometry for the desktop (no React, so tests can import it). */

export interface Win {
  id: string;
  /** this window's history; `at` is the current entry */
  history: string[];
  at: number;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  min: boolean;
  max: boolean;
}

export interface Insets {
  top: number;
  bottom: number;
}

export const current = (w: Win) => w.history[w.at]!;

const MIN_W = 420;
const MIN_H = 300;

/** keeps a window under the menu bar, above the dock, and grabbable; a maximized window is left as it is */
export function clampWin(w: Win, vw: number, vh: number, insets: Insets): Win {
  if (w.max) return w;
  const width = Math.min(Math.max(MIN_W, w.w), vw - 16);
  const height = Math.min(Math.max(MIN_H, w.h), vh - insets.top - insets.bottom - 8);
  const x = Math.min(Math.max(-width + 160, w.x), vw - 160);
  const y = Math.min(Math.max(insets.top + 4, w.y), vh - insets.bottom - 48);
  return { ...w, w: width, h: height, x, y };
}
