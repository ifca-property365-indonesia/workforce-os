"use client";

import { useCallback, useEffect, useState } from "react";
import { DESKTOP_MIN_WIDTH, VIEW_KEY, type ViewMode } from "./view-mode";

const wide = () => window.innerWidth >= DESKTOP_MIN_WIDTH;
const chosen = (): ViewMode | null => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "classic" || v === "desktop" ? v : null;
  } catch {
    return null;
  }
};

export function useViewMode(): { mode: ViewMode | null; canDesktop: boolean; setMode: (m: ViewMode) => void } {
  // null until mounted: the server and the first client render are classic
  const [mode, setModeState] = useState<ViewMode | null>(null);
  const [canDesktop, setCanDesktop] = useState(false);
  useEffect(() => {
    let last: ViewMode | null = null;
    const decide = () => {
      setCanDesktop(wide());
      const m: ViewMode = wide() && chosen() !== "classic" ? "desktop" : "classic";
      // narrowing the window below the desktop: the classic layout must show the focused window's page, not the first one
      if (last === "desktop" && m === "classic") return window.location.reload();
      last = m;
      document.documentElement.dataset.view = m;
      setModeState(m);
    };
    decide();
    window.addEventListener("resize", decide);
    return () => window.removeEventListener("resize", decide);
  }, []);
  const setMode = useCallback((m: ViewMode) => {
    try {
      localStorage.setItem(VIEW_KEY, m);
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
    // the page under the classic layout is the one the server rendered; a reload shows the address bar's page
    window.location.reload();
  }, []);
  return { mode, canDesktop, setMode };
}
