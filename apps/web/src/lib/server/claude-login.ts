import "server-only";
import { claudeLoginKey, type ClaudeLoginState } from "@wfos/shared";
import { serverEnv } from "./env";
import { redis } from "./queue";

/*
 * Connect Claude (after AIRIS 8314578): the worker runs `claude setup-token` for one workspace and the Owner signs in at
 * claude.com; the token it prints becomes the workspace's credential. This is the state the worker keeps for the page.
 */

export function claudeLoginRedisKey(workspaceId: string): string {
  return claudeLoginKey(workspaceId, serverEnv.namespace);
}

export async function readClaudeLogin(workspaceId: string): Promise<ClaudeLoginState | null> {
  const raw = await redis().get(claudeLoginRedisKey(workspaceId));
  return raw ? (JSON.parse(raw) as ClaudeLoginState) : null;
}
