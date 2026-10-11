/**
 * BullMQ job ids that make a repeated request a no-op: a second `add` with an id that is already queued (or kept
 * after finishing) is ignored by BullMQ.
 */

/** Regenerate: a double click (or a retried request) within the same 10-second window answers the message once. */
export function regenJobId(userMessageId: string, now = Date.now()): string {
  return `regen-${userMessageId}-${Math.floor(now / 10_000)}`;
}
