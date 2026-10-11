#!/usr/bin/env node
// pnpm --filter @wfos/web i18n:rehash                      accept every current Indonesian translation
// pnpm --filter @wfos/web i18n:rehash --only skills.title  accept only these keys (or prefixes); repeat or comma-separate
// pnpm --filter @wfos/web i18n:rehash --prune              only drop hashes of keys that no longer exist
// Writes messages/id/.source-hashes.json (see docs/upgrade/I18N.md, "Source hashes").
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HASHES_FILE, checkSourceHashes, loadEnglish, loadHashes, rehash } from "./i18n-hashes.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => a !== "--");
const only = [];
let prune = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--only") {
    const v = args[++i];
    if (!v) {
      console.error("--only needs a key, e.g. --only skills.editor.title");
      process.exit(2);
    }
    only.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
  } else if (a.startsWith("--only=")) only.push(...a.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
  else if (a === "--prune") prune = true;
  else {
    console.error(`unknown argument ${a}`);
    process.exit(2);
  }
}

const english = loadEnglish(webRoot);
const stored = loadHashes(webRoot);
let next;
try {
  // --prune alone keeps every stored hash of an existing key as it is; otherwise accept all keys or the --only ones
  next = prune && !only.length ? rehash(english, stored, { only: [], prune: true, pruneOnly: true }) : rehash(english, stored, { only, prune });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
writeFileSync(path.join(webRoot, HASHES_FILE), `${JSON.stringify(next, null, 2)}\n`);
const left = checkSourceHashes(english, next);
console.log(`${HASHES_FILE}: ${Object.keys(next).length} hashes; ${left.stale.length} stale, ${left.missing.length} without a hash, ${left.orphaned.length} orphaned`);
