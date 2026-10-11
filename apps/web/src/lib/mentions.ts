/**
 * @mentions in team chats. Pure functions, shared by the messages route (what gets stored in meta) and the
 * composer (autocomplete). Names may contain spaces ("@Budi Santoso"); the longest matching name wins.
 */

export interface MentionMember {
  id: string;
  name: string;
}

export interface ParsedMentions {
  /** member ids, deduplicated, in the order of `members` */
  mentions: string[];
  /** @semua / @everyone */
  mentionAll: boolean;
}

/** Words that address the whole team. */
export const MENTION_ALL_WORDS = ["semua", "everyone"] as const;

const WORD = /[\p{L}\p{N}_]/u;
const isWordChar = (c: string | undefined) => !!c && WORD.test(c);

/**
 * Find the mentions in a message. An "@" only counts at the start or after a non-word character (so
 * "budi@example.com" is not a mention), and a name only counts when it ends at a word boundary
 * ("@Budiman" does not mention "Budi"). Matching is case-insensitive.
 */
export function parseMentions(content: string, members: readonly MentionMember[]): ParsedMentions {
  type Candidate = { needle: string; id: string | null };
  const candidates: Candidate[] = [
    ...MENTION_ALL_WORDS.map((w) => ({ needle: w, id: null })),
    ...members.map((m) => ({ needle: m.name.trim().replace(/\s+/g, " ").toLowerCase(), id: m.id })).filter((c) => c.needle),
  ].sort((a, b) => b.needle.length - a.needle.length);

  const lower = content.toLowerCase();
  const found = new Set<string>();
  let mentionAll = false;
  for (let i = lower.indexOf("@"); i !== -1; i = lower.indexOf("@", i + 1)) {
    if (isWordChar(lower[i - 1])) continue;
    // collapse runs of spaces after the "@" so "@Budi   Santoso" still matches "Budi Santoso"
    const rest = lower.slice(i + 1, i + 1 + 200).replace(/[ \t]+/g, " ");
    const hit = candidates.find((c) => rest.startsWith(c.needle) && !isWordChar(rest[c.needle.length]));
    if (!hit) continue;
    if (hit.id === null) mentionAll = true;
    else found.add(hit.id);
  }
  const mentions = members.map((m) => m.id).filter((id, idx, all) => found.has(id) && all.indexOf(id) === idx);
  return { mentions, mentionAll };
}

export interface ActiveMention {
  /** index of the "@" */
  start: number;
  /** what was typed after it, up to the caret */
  query: string;
}

/**
 * The mention being typed at the caret, if any: an "@" at a word start, followed by up to 40 characters
 * without a newline. Spaces are allowed because names may contain them; the caller closes the list when
 * nothing matches.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1 || isWordChar(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@]/.test(query) || query.startsWith(" ")) return null;
  return { start: at, query };
}

/** Does a name (or the @semua word) match what was typed? Matches the start of the name or of any word in it. */
export function mentionMatches(name: string, query: string): boolean {
  const n = name.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, " ");
  if (!q) return true;
  return n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q));
}

/**
 * Replace the mention being typed with "@Name " and return the new text and caret. The whole token goes, not just
 * the part before the caret: with the caret mid-word ("@Sa|ri") the rest of that word is dropped, and when the full
 * name already follows the "@" ("@Bu|di Santoso" → "Budi Santoso") all of it is replaced, so no tail is duplicated.
 */
export function insertMention(text: string, mention: ActiveMention, caret: number, name: string): { text: string; caret: number } {
  let end = caret;
  while (end < text.length && isWordChar(text[end])) end++;
  const typed = text.slice(mention.start + 1).toLowerCase();
  const needle = name.toLowerCase();
  if (typed.startsWith(needle) && !isWordChar(typed[needle.length])) end = Math.max(end, mention.start + 1 + needle.length);
  const after = text.slice(end).replace(/^ /, "");
  // "@Sari, …" / "@Sari." keep the punctuation right after the name; otherwise a space separates the next word
  const inserted = /^[^\s\p{L}\p{N}_]/u.test(after) ? `@${name}` : `@${name} `;
  return { text: text.slice(0, mention.start) + inserted + after, caret: mention.start + inserted.length };
}

/** The mention the user just completed: the list stays closed for it until the text changes again. */
export interface PickedMention {
  start: number;
  text: string;
}

/**
 * Should the suggestion list stay closed for this @query? Yes when the user closed it with Escape for this "@", or
 * when they just picked a member and have not typed since — otherwise "@Sari " would reopen the list for "Sari Dewi".
 */
export function mentionSuppressed(active: ActiveMention, text: string, dismissedAt: number | null, picked: PickedMention | null): boolean {
  if (dismissedAt === active.start) return true;
  return !!picked && picked.start === active.start && picked.text === text;
}
