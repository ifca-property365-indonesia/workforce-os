import { Redis } from "ioredis";
import { channelFor } from "@wfos/shared";
import { getSession } from "@/lib/server/auth";
import { serverEnv } from "@/lib/server/env";
import { guestEventAllowed } from "@/lib/server/share";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-Sent Events: task steps, status changes, approvals, chat deltas for this workspace. */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const sub = new Redis(serverEnv.redisUrl, { maxRetriesPerRequest: null });
  const encoder = new TextEncoder();
  let heartbeat: NodeJS.Timeout | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* closed */
        }
      };
      send(`retry: 3000\n\n`);
      send(`event: ready\ndata: {}\n\n`);
      sub.on("message", (_ch, msg) => {
        if (session.guest) {
          // a view-only guest gets work and people only (never chat, approvals, mail or money)
          let type: unknown;
          try {
            type = (JSON.parse(msg) as { type?: unknown }).type;
          } catch {
            return;
          }
          if (!guestEventAllowed(type)) return;
        }
        send(`data: ${msg}\n\n`);
      });
      await sub.subscribe(channelFor(session.workspaceId, serverEnv.namespace));
      heartbeat = setInterval(() => send(`: ping\n\n`), 20000);
      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        sub.disconnect();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      clearInterval(heartbeat);
      sub.disconnect();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
