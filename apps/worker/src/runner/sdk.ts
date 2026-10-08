import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";

export type QueryFn = typeof realQuery;

let impl: QueryFn = realQuery;

/** The Agent SDK entry point, swappable so tests run against the scripted mock runner (never the real service). */
export function agentQuery(params: Parameters<QueryFn>[0]): ReturnType<QueryFn> {
  return impl(params);
}

export function setQueryImpl(fn: QueryFn | null): void {
  impl = fn ?? realQuery;
}
