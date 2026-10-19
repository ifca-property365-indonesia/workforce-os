"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { PageKey } from "./routes";

/** The app pages a window can show: the same modules the classic layout routes to, loaded on demand. */
// next/dynamic needs a literal import() per page
const Pages = {
  dashboard: dynamic(() => import("@/app/(app)/dashboard/page")),
  chat: dynamic(() => import("@/app/(app)/chat/page")),
  tasks: dynamic(() => import("@/app/(app)/tasks/page")),
  task: dynamic(() => import("@/app/(app)/tasks/[id]/page")),
  approvals: dynamic(() => import("@/app/(app)/approvals/page")),
  outbox: dynamic(() => import("@/app/(app)/outbox/page")),
  employees: dynamic(() => import("@/app/(app)/employees/page")),
  hire: dynamic(() => import("@/app/(app)/employees/hire/page")),
  employee: dynamic(() => import("@/app/(app)/employees/[id]/page")),
  teams: dynamic(() => import("@/app/(app)/teams/page")),
  routines: dynamic(() => import("@/app/(app)/routines/page")),
  clients: dynamic(() => import("@/app/(app)/clients/page")),
  client: dynamic(() => import("@/app/(app)/clients/[id]/page")),
  apps: dynamic(() => import("@/app/(app)/apps/page")),
  app: dynamic(() => import("@/app/(app)/apps/[id]/page")),
  uiTemplates: dynamic(() => import("@/app/(app)/apps/templates/page")),
  knowledge: dynamic(() => import("@/app/(app)/knowledge/page")),
  settings: dynamic(() => import("@/app/(app)/settings/page")),
  account: dynamic(() => import("@/app/(app)/account/page")),
} satisfies Record<PageKey, unknown>;

type PageProps = { params: Promise<Record<string, string>> };
export function pageComponent(page: PageKey): ComponentType<PageProps> {
  return Pages[page] as unknown as ComponentType<PageProps>;
}
