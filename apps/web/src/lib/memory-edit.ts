/** yyyy-mm-dd in the browser's zone, for <input type="date"> */
export function dateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** the chosen day, until its end */
export const endOfDay = (v: string) => (v ? new Date(`${v}T23:59:59`).toISOString() : null);

/**
 * The PATCH body for a memory edit: the expiry only when the date input changed. Re-sending an untouched date would
 * move a precise expiry (set by the employee or the nightly tidy) to the end of that day in this browser's zone.
 */
export function memoryPatch(v: { content: string; expires: string; expiresWas: string }): { content: string; expiresAt?: string | null } {
  return v.expires === v.expiresWas ? { content: v.content } : { content: v.content, expiresAt: endOfDay(v.expires) };
}
