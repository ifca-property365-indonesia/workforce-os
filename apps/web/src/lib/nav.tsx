"use client";

import NextLink from "next/link";
import { usePathname as useNextPathname, useRouter as useNextRouter, useSearchParams as useNextSearchParams } from "next/navigation";
import { createContext, forwardRef, useCallback, useContext, useMemo, type ComponentProps, type MouseEvent } from "react";

/**
 * Navigation that works both in the classic layout and inside a desktop window.
 *
 * App pages and the components they render import `Link`, `useRouter`, `usePathname` and `useSearchParams` from here
 * instead of next/link and next/navigation. In the classic layout these are Next's own. Inside a window (WindowNavContext)
 * they read and change that window's path, so a link in the Approvals window navigates the Approvals window. Outside a
 * window but on the desktop (DesktopContext), an app link opens or focuses the window for it.
 */

export interface WindowNav {
  /** path + query of this window, e.g. "/tasks/abc?tab=code" */
  path: string;
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
}
export const WindowNavContext = createContext<WindowNav | null>(null);

export interface DesktopNav {
  /** whether `href` is an app page the desktop can show in a window */
  handles: (href: string) => boolean;
  /** open (or focus) the window for `href` */
  open: (href: string, opts?: { newWindow?: boolean }) => void;
}
export const DesktopContext = createContext<DesktopNav | null>(null);

/** the desktop, when the app runs as one; null in the classic layout */
export function useDesktop(): DesktopNav | null {
  return useContext(DesktopContext);
}

const hrefOf = (href: ComponentProps<typeof NextLink>["href"]): string => {
  if (typeof href === "string") return href;
  const q = href.query ? new URLSearchParams(href.query as Record<string, string>).toString() : "";
  return `${href.pathname ?? ""}${q ? `?${q}` : ""}${href.hash ? `#${href.hash.replace(/^#/, "")}` : ""}`;
};

/** go to `href` from wherever the caller is: its window, a new window on the desktop, or a normal navigation */
export function useOpen(): (href: string) => void {
  const router = useRouter();
  const desk = useContext(DesktopContext);
  const win = useContext(WindowNavContext);
  return useCallback(
    (href: string) => {
      if (!win && desk?.handles(href)) desk.open(href);
      else router.push(href);
    },
    [router, desk, win],
  );
}

type LinkProps = ComponentProps<typeof NextLink>;

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ onClick, href, ...rest }, ref) {
  const win = useContext(WindowNavContext);
  const desk = useContext(DesktopContext);
  const target = hrefOf(href);
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    // a modified click or an explicit target keeps the browser's behaviour (new tab, download…)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target) return;
    if (!desk?.handles(target)) return;
    e.preventDefault();
    if (win) win.push(target);
    else desk.open(target);
  };
  return <NextLink ref={ref} href={href} {...rest} onClick={click} />;
});
export default Link;

export function useRouter(): ReturnType<typeof useNextRouter> {
  const next = useNextRouter();
  const win = useContext(WindowNavContext);
  return useMemo(
    () =>
      win
        ? {
            ...next,
            push: (href: string) => win.push(href),
            replace: (href: string) => win.replace(href),
            back: () => win.back(),
          }
        : next,
    [next, win],
  );
}

export function usePathname(): string {
  const next = useNextPathname();
  const win = useContext(WindowNavContext);
  return win ? win.path.split(/[?#]/)[0]! : next;
}

export function useSearchParams(): ReturnType<typeof useNextSearchParams> {
  const next = useNextSearchParams();
  const win = useContext(WindowNavContext);
  const query = win ? (win.path.split("#")[0]!.split("?")[1] ?? "") : null;
  return useMemo(() => (query === null ? next : (new URLSearchParams(query) as unknown as ReturnType<typeof useNextSearchParams>)), [next, query]);
}
