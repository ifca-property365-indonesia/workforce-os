"use client";

import { Fragment, type ReactNode } from "react";
import { parseFlow, screenshotNumber, type Flow } from "@/lib/doc-format";
import { cn } from "@/lib/utils";

/**
 * C9: an app document's markdown, rendered as React elements only (never as HTML: documents are written by
 * employees and may quote untrusted content). Headings, paragraphs, lists, tables, quotes, code; ```alur blocks as a
 * flow diagram; ![caption](#n) as screenshot n of the document's app test (no other images, no raw HTML); links only
 * to http(s).
 */
export function DocMarkdown({ md, shot, className }: { md: string; shot?: (n: number) => string | null; className?: string }) {
  return <div className={cn("space-y-3 text-sm leading-relaxed", className)}>{blocks(md, shot)}</div>;
}

function inline(text: string, shot?: (n: number) => string | null): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      const n = screenshotNumber(m[3]!);
      const src = n !== null ? shot?.(n) : null;
      out.push(
        src ? (
          <figure key={k++} className="my-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset */}
            <img src={src} alt={m[2] ?? ""} className="max-h-80 rounded-lg border" loading="lazy" />
            {m[2] && <figcaption className="mt-1 text-xs text-muted-foreground">{m[2]}</figcaption>}
          </figure>
        ) : (
          <span key={k++} className="text-xs text-muted-foreground">
            [{m[2] || m[3]}]
          </span>
        ),
      );
    } else if (m[4])
      out.push(
        <a key={k++} href={m[6]} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          {m[5]}
        </a>,
      );
    else if (m[7]) out.push(<strong key={k++}>{m[8]}</strong>);
    else if (m[9])
      out.push(
        <code key={k++} className="rounded bg-muted px-1 font-mono text-[0.85em]">
          {m[10]}
        </code>,
      );
    else if (m[11]) out.push(<em key={k++}>{m[12]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function blocks(md: string, shot?: (n: number) => string | null): ReactNode[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```\s*([\w-]*)\s*$/.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) body.push(lines[i++]!);
      i++;
      out.push(fence[1] === "alur" || fence[1] === "flow" ? <FlowDiagram key={k++} flow={parseFlow(body.join("\n"))} /> : <pre key={k++} className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{body.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const cls = ["font-display text-[1.6rem] leading-tight", "font-display text-[1.3rem] leading-tight pt-2", "text-base font-semibold pt-1", "text-sm font-semibold"][level - 1];
      const Tag = (["h2", "h3", "h4", "h5"] as const)[level - 1]!;
      out.push(
        <Tag key={k++} className={cls}>
          {inline(h[2]!, shot)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+[.)])\s+/, ""));
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={k++} className={cn("space-y-1 pl-5", ordered ? "list-decimal" : "list-disc")}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, shot)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const cells = lines[i++]!.trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      }
      out.push(
        <div key={k++} className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <tbody>
              {rows.map((r, j) => (
                <tr key={j} className={j === 0 ? "bg-muted/60 font-semibold" : "border-t"}>
                  {r.map((c, n) => (
                    <td key={n} className="px-2 py-1 align-top">
                      {inline(c, shot)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push(
        <blockquote key={k++} className="border-l-2 pl-3 text-muted-foreground">
          {inline(q.join(" "), shot)}
        </blockquote>,
      );
      continue;
    }
    if (/^-{3,}\s*$/.test(line)) {
      out.push(<hr key={k++} />);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+[.)])\s+|\s*\||>|-{3,}\s*$)/.test(lines[i]!)) para.push(lines[i++]!);
    out.push(<p key={k++}>{inline(para.join(" "), shot)}</p>);
  }
  return out;
}

/** A business flow block as a vertical diagram: start, role steps, decisions with their yes/no, end. */
function FlowDiagram({ flow }: { flow: Flow }) {
  return (
    <figure className="rounded-xl border bg-muted/30 p-3" aria-label={flow.title ?? undefined}>
      {flow.title && <figcaption className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{flow.title}</figcaption>}
      <ol className="flex flex-col items-center gap-0">
        {flow.items.map((it, j) => (
          <Fragment key={j}>
            {j > 0 && <li aria-hidden className="h-4 w-px bg-border" />}
            <li className="w-full max-w-md">
              {it.type === "start" || it.type === "end" ? (
                <div className={cn("mx-auto w-fit rounded-full px-4 py-1.5 text-center text-sm font-semibold", it.type === "start" ? "bg-[var(--sign-biru)]/15" : "bg-success/15")}>{it.text}</div>
              ) : it.type === "step" ? (
                <div className="rounded-lg border bg-card px-3 py-2 text-sm">
                  {it.role && <span className="mr-1.5 rounded bg-secondary px-1.5 py-0.5 text-[11px] font-bold">{it.role}</span>}
                  {it.text}
                </div>
              ) : it.type === "decision" ? (
                <div className="rounded-lg border-2 border-dashed border-warning/60 bg-card px-3 py-2 text-sm">
                  <div className="font-semibold">◆ {it.question}</div>
                  <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                    <span className="rounded bg-success/10 px-2 py-1">✓ {it.yes || "—"}</span>
                    <span className="rounded bg-destructive/10 px-2 py-1">✕ {it.no || "—"}</span>
                  </div>
                </div>
              ) : null}
            </li>
          </Fragment>
        ))}
      </ol>
    </figure>
  );
}
