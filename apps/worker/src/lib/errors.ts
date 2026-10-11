/** The message of anything thrown: an Error's message, otherwise its string form (a thrown string, null, …). */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
