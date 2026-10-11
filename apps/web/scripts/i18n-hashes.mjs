// Source hashes for the Indonesian catalog: messages/id/.source-hashes.json maps "<namespace>.<key.path>" to the
// first 12 hex characters of the sha256 of the English string the translation was made from. When an English string
// changes, its hash no longer matches and the i18n test names the translation as stale. Shared by the
// i18n:rehash script and apps/web/test/i18n.test.ts.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const HASH_LENGTH = 12;
export const HASHES_FILE = path.join("messages", "id", ".source-hashes.json");

/** sha256 of the English source string, first 12 hex characters. */
export function sourceHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, HASH_LENGTH);
}

/** { a: { b: "x" } } → Map { "a.b" => "x" } */
export function flattenCatalog(tree, prefix = "") {
  const out = new Map();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else if (v && typeof v === "object") for (const [kk, vv] of flattenCatalog(v, key)) out.set(kk, vv);
  }
  return out;
}

/** Every English string of the app as "<namespace>.<key.path>" → text (namespaces are the messages/en/*.json files). */
export function loadEnglish(webRoot) {
  const dir = path.join(webRoot, "messages", "en");
  const out = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && !x.startsWith(".")).sort()) {
    const ns = f.replace(/\.json$/, "");
    for (const [k, v] of flattenCatalog(JSON.parse(readFileSync(path.join(dir, f), "utf8")), ns)) out.set(k, v);
  }
  return out;
}

export function loadHashes(webRoot) {
  try {
    return JSON.parse(readFileSync(path.join(webRoot, HASHES_FILE), "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return {};
    throw e;
  }
}

/**
 * Compare the English catalog with the stored hashes: `stale` keys changed in English since they were translated,
 * `missing` keys have no stored hash (new, or never accepted), `orphaned` hashes belong to keys that no longer exist.
 */
export function checkSourceHashes(english, stored) {
  const stale = [];
  const missing = [];
  for (const [key, text] of english) {
    const h = Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : undefined;
    if (h === undefined) missing.push(key);
    else if (h !== sourceHash(text)) stale.push(key);
  }
  const orphaned = Object.keys(stored).filter((k) => !english.has(k));
  return { stale, missing, orphaned };
}

/** Does `key` fall under `selector` (the key itself, or a namespace / group prefix like "skills.editor")? */
function selects(selector, key) {
  return key === selector || key.startsWith(`${selector}.`);
}

/**
 * The hashes to store. Without `only`: every English key (all current translations accepted) and nothing else.
 * With `only`: just the selected keys (or prefixes) are re-accepted; the rest stays as stored. `prune` drops the
 * hashes of keys that no longer exist; with `pruneOnly` nothing else changes. Throws when a selector matches no key.
 */
export function rehash(english, stored, opts = {}) {
  const next = { ...stored };
  const only = opts.only ?? [];
  if (opts.pruneOnly) {
    // nothing accepted
  } else if (!only.length) {
    for (const k of Object.keys(next)) delete next[k];
    for (const [key, text] of english) next[key] = sourceHash(text);
  } else {
    for (const sel of only) {
      const keys = [...english.keys()].filter((k) => selects(sel, k));
      if (!keys.length) throw new Error(`no English key matches ${sel}`);
      for (const k of keys) next[k] = sourceHash(english.get(k));
    }
  }
  if (opts.prune) for (const k of Object.keys(next)) if (!english.has(k)) delete next[k];
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
