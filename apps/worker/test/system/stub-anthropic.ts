import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the Anthropic Messages API (streaming SSE), so the real Claude Code CLI can run a
 * scripted session inside the sandbox without calling the real service. Each main-loop request gets the next
 * scripted assistant turn (counted by the assistant turns already in the conversation).
 */
export type StubTurn = { tool: string; input: Record<string, unknown> } | { text: string };

export interface StubRequest {
  path: string;
  auth: string;
  apiKey: string;
  body: { model?: string; messages?: { role: string; content: unknown }[]; tools?: { name: string }[]; system?: unknown };
}

export interface StubApi {
  url: string;
  requests: StubRequest[];
  /** text of every tool_result the CLI sent back */
  toolResults(): string[];
  close(): Promise<void>;
}

function sse(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function startStubApi(script: StubTurn[]): Promise<StubApi> {
  const requests: StubRequest[] = [];
  let msgN = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), apiKey: String(req.headers["x-api-key"] ?? ""), body });
      if (!(req.url ?? "").startsWith("/v1/messages") || (req.url ?? "").includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const mainLoop = Array.isArray(body.tools) && body.tools.some((t: { name: string }) => t.name === "Bash");
      const assistantTurns = (body.messages ?? []).filter((m: { role: string }) => m.role === "assistant").length;
      const turn: StubTurn = mainLoop ? (script[assistantTurns] ?? { text: "Finished." }) : { text: "ok" };
      const id = `msg_stub_${++msgN}`;
      const model = body.model ?? "claude-sonnet-5-5";
      if (!body.stream) {
        const content = "text" in turn ? [{ type: "text", text: turn.text }] : [{ type: "tool_use", id: `toolu_stub_${msgN}`, name: turn.tool, input: turn.input }];
        res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" }).end(
          JSON.stringify({ id, type: "message", role: "assistant", model, content, stop_reason: "text" in turn ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 50, output_tokens: 10 } }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "anthropic-ratelimit-unified-status": "allowed" });
      sse(res, "message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } });
      if ("text" in turn) {
        sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: turn.text } });
      } else {
        sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_stub_${msgN}`, name: turn.tool, input: {} } });
        sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) } });
      }
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "text" in turn ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } });
      sse(res, "message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    toolResults: () => {
      const out = new Set<string>();
      for (const r of requests) {
        for (const m of r.body.messages ?? []) {
          if (m.role !== "user" || !Array.isArray(m.content)) continue;
          for (const b of m.content as { type: string; content?: unknown }[]) {
            if (b.type !== "tool_result") continue;
            const c = b.content;
            out.add(typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join("") : JSON.stringify(c));
          }
        }
      }
      return [...out];
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
