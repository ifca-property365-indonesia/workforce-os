"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import php from "highlight.js/lib/languages/php";
import { cn } from "@/lib/utils";

for (const [name, lang] of Object.entries({ typescript, javascript, python, json, css, xml, markdown, bash, yaml, sql, go, rust, java, php })) hljs.registerLanguage(name, lang);

const EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", json: "json", css: "css", scss: "css", html: "xml", xml: "xml", svg: "xml", vue: "xml", md: "markdown", sh: "bash", bash: "bash",
  yml: "yaml", yaml: "yaml", sql: "sql", go: "go", rs: "rust", java: "java", php: "php",
};

interface FileDiff {
  path: string;
  hunks: { header: string; lines: { kind: "+" | "-" | " "; text: string }[] }[];
  added: number;
  removed: number;
  binary: boolean;
}

/** Split a unified `git diff` into files and hunks. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      cur = { path: m[2]!, hunks: [], added: 0, removed: 0, binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("Binary files")) cur.binary = true;
    else if (line.startsWith("@@")) cur.hunks.push({ header: line, lines: [] });
    else if (cur.hunks.length && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      const kind = line[0] as "+" | "-" | " ";
      if (kind === "+") cur.added++;
      if (kind === "-") cur.removed++;
      cur.hunks[cur.hunks.length - 1]!.lines.push({ kind, text: line.slice(1) });
    }
  }
  return files;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** highlight.js escapes the code it highlights; anything else is escaped here. */
function highlight(text: string, lang: string | undefined): string {
  try {
    return lang ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : escapeHtml(text);
  } catch {
    return escapeHtml(text);
  }
}

/** File tree with +/- counts and a syntax-highlighted diff per file. */
export function CodeDiff({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const t = useTranslations("inspector");
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [open, setOpen] = useState<string | null>(files[0]?.path ?? null);
  if (!files.length) return <p className="text-sm text-muted-foreground">{t("code.noChanges")}</p>;
  const file = files.find((f) => f.path === open) ?? files[0]!;
  const lang = EXT[file.path.split(".").pop()?.toLowerCase() ?? ""];
  return (
    <div className="grid gap-3 lg:grid-cols-[16rem_1fr]">
      <ul className="max-h-[32rem] space-y-0.5 overflow-auto rounded-lg border p-1 text-xs" aria-label={t("code.files")}>
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => setOpen(f.path)}
              className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono hover:bg-accent", f.path === file.path && "bg-accent")}
            >
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="text-emerald-600">+{f.added}</span>
              <span className="text-destructive">-{f.removed}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/30 font-mono text-xs">
        {file.binary && <p className="p-3 text-muted-foreground">{t("code.binary")}</p>}
        {file.hunks.map((h, i) => (
          <div key={i}>
            <div className="sticky top-0 bg-muted px-3 py-1 text-muted-foreground">{h.header}</div>
            {h.lines.map((l, j) => (
              <div key={j} className={cn("whitespace-pre px-3", l.kind === "+" && "bg-emerald-500/10", l.kind === "-" && "bg-red-500/10")}>
                <span className="mr-2 select-none text-muted-foreground">{l.kind}</span>
                <span dangerouslySetInnerHTML={{ __html: highlight(l.text, lang) }} />
              </div>
            ))}
          </div>
        ))}
        {truncated && <p className="p-3 text-muted-foreground">{t("code.truncated")}</p>}
      </div>
    </div>
  );
}
