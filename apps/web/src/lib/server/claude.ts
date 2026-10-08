import "server-only";
import type { ClaudeCredentialStatus } from "@wfos/db";

/** Compact form for the app shell: is a credential in effect, and where does it come from. */
export function claudeSummary(s: ClaudeCredentialStatus) {
  return { credentialPresent: !!s.effective, source: s.effective?.source ?? null, type: s.effective?.type ?? null };
}
