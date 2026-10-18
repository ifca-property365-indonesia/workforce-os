/**
 * C9: the pure parts of showing an app document (tested in test/doc-format.test.ts): the ```alur flow blocks of a
 * business flow, a line diff against the approved version, and a presentation's slides.
 */

export type FlowItem = { type: "start" | "end"; text: string } | { type: "step"; role: string; text: string } | { type: "decision"; question: string; yes: string; no: string };
export interface Flow {
  title: string | null;
  items: FlowItem[];
}

/**
 * A ```alur block: `judul:`, `mulai:`, `<Role>: <step>`, `? <question>` followed by indented `ya:` / `tidak:` lines,
 * `selesai:`. Unknown lines become a step without a role (nothing is dropped silently).
 */
export function parseFlow(src: string): Flow {
  const lines = src.split("\n");
  const flow: Flow = { title: null, items: [] };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line) continue;
    const kv = /^([^:?]{1,40}):\s*(.*)$/.exec(line);
    const key = kv?.[1]!.trim().toLowerCase();
    if (line.startsWith("?")) {
      const d: FlowItem = { type: "decision", question: line.slice(1).trim(), yes: "", no: "" };
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) {
        const sub = /^\s*(ya|yes|tidak|no)\s*:\s*(.*)$/i.exec(lines[++i]!);
        if (!sub) continue;
        if (/^(ya|yes)$/i.test(sub[1]!)) d.yes = sub[2]!.trim();
        else d.no = sub[2]!.trim();
      }
      flow.items.push(d);
    } else if (key === "judul" || key === "title") flow.title = kv![2]!.trim();
    else if (key === "mulai" || key === "start") flow.items.push({ type: "start", text: kv![2]!.trim() });
    else if (key === "selesai" || key === "end") flow.items.push({ type: "end", text: kv![2]!.trim() });
    else if (kv) flow.items.push({ type: "step", role: kv[1]!.trim(), text: kv[2]!.trim() });
    else flow.items.push({ type: "step", role: "", text: line });
  }
  return flow;
}

export type DiffLine = { op: "same" | "add" | "del"; text: string };
const DIFF_MAX = 1500;

/** Line diff (LCS) of the approved version (a) and this one (b). Very long documents fall back to "all changed". */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length > DIFF_MAX || y.length > DIFF_MAX) return [...x.map((t) => ({ op: "del" as const, text: t })), ...y.map((t) => ({ op: "add" as const, text: t }))];
  const n = x.length;
  const m = y.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: "same", text: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "del", text: x[i++]! });
    else out.push({ op: "add", text: y[j++]! });
  }
  while (i < n) out.push({ op: "del", text: x[i++]! });
  while (j < m) out.push({ op: "add", text: y[j++]! });
  return out;
}

/** A presentation's slides: separated by a line with only `---` (outside fenced code). */
export function splitSlides(md: string): string[] {
  const slides: string[] = [];
  let cur: string[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line.trim())) fenced = !fenced;
    if (!fenced && /^-{3,}\s*$/.test(line)) {
      slides.push(cur.join("\n").trim());
      cur = [];
    } else cur.push(line);
  }
  slides.push(cur.join("\n").trim());
  return slides.filter(Boolean);
}

/** `#n` image targets of a deck → that screenshot of its test; anything else is not an image the app shows. */
export function screenshotNumber(target: string): number | null {
  const m = /^#(\d{1,4})$/.exec(target.trim());
  return m ? Number(m[1]) : null;
}
