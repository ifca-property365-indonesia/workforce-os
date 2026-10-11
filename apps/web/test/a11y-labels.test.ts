import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The form-label "lint": every shadcn `<Label>` must name something, so screen readers announce the field
 * and clicking the label focuses it. A Label passes when it has `htmlFor`, or when its `id` is referenced by an
 * `aria-labelledby` in the same file (a radio group, a toggle grid, a read-only value). A literal `htmlFor="x"`
 * must also point at an `id="x"` in the same file.
 * Escape hatch for a deliberate exception: an `a11y-ignore` comment on the line or the line above.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(f) ? [p] : [];
  });
}

type Attrs = ts.JsxAttributes;

function attr(attrs: Attrs, name: string): ts.JsxAttribute | undefined {
  return attrs.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

/** The attribute value as comparable text: a literal's value, or an expression's source text (`labelId`, `` `${uid}-x` ``). */
function value(sf: ts.SourceFile, a: ts.JsxAttribute | undefined): { literal: string | null; text: string } | null {
  const init = a?.initializer;
  if (!init) return null;
  if (ts.isStringLiteral(init)) return { literal: init.text, text: init.text };
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { literal: e.text, text: e.text };
    return { literal: null, text: e.getText(sf) };
  }
  return null;
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function scanSource(file: string, source: string) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split("\n");
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
  const ignored = (n: ts.Node) => /a11y-ignore/.test(lines[at(n)] ?? "") || /a11y-ignore/.test(lines[at(n) - 1] ?? "");

  const labels: ts.JsxAttributes[] = [];
  const labelledBy = new Set<string>();
  const ids = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(sf) === "Label") labels.push(node.attributes);
      const lb = value(sf, attr(node.attributes, "aria-labelledby"));
      if (lb) for (const part of lb.literal !== null ? lb.literal.split(/\s+/) : [lb.text]) labelledBy.add(part);
      const id = value(sf, attr(node.attributes, "id"));
      if (id?.literal !== null && id?.literal !== undefined) ids.add(id.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const unnamed: Finding[] = [];
  const dangling: Finding[] = [];
  for (const attrs of labels) {
    const el = attrs.parent;
    if (ignored(el)) continue;
    const htmlFor = value(sf, attr(attrs, "htmlFor"));
    const id = value(sf, attr(attrs, "id"));
    const snippet = el.getText(sf).replace(/\s+/g, " ").slice(0, 80);
    if (htmlFor) {
      if (htmlFor.literal !== null && !ids.has(htmlFor.literal)) dangling.push({ file, line: at(el) + 1, text: `htmlFor="${htmlFor.literal}" has no id="${htmlFor.literal}": ${snippet}` });
    } else if (!id || !labelledBy.has(id.text)) {
      unnamed.push({ file, line: at(el) + 1, text: snippet });
    }
  }
  return { unnamed, dangling };
}

function scan() {
  const unnamed: Finding[] = [];
  const dangling: Finding[] = [];
  for (const file of files(SRC, /\.tsx$/)) {
    const r = scanSource(path.relative(ROOT, file), readFileSync(file, "utf8"));
    unnamed.push(...r.unnamed);
    dangling.push(...r.dangling);
  }
  return { unnamed, dangling };
}

const fmt = (fs: Finding[]) => fs.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");

describe("form labels in src", () => {
  const result = scan();

  it("every <Label> has htmlFor, or an id used by aria-labelledby", () => {
    expect(fmt(result.unnamed)).toBe("");
  });

  it("every literal htmlFor points at an id in the same file", () => {
    expect(fmt(result.dangling)).toBe("");
  });
});

describe("label scanner (fake sources)", () => {
  const check = (src: string) => scanSource("fake.tsx", src);

  it("flags a bare Label and a Label whose id nothing references", () => {
    const r = check(`const a = <div><Label>Name</Label><Input /><Label id="x" className="text-xs">Group</Label></div>;`);
    expect(r.unnamed.map((f) => f.text)).toEqual(["<Label>", `<Label id="x" className="text-xs">`]);
  });

  it("accepts htmlFor, aria-labelledby (literal list or expression) and the a11y-ignore escape", () => {
    const r = check(`
      const a = (
        <div>
          <Label htmlFor={\`\${uid}-name\`}>Name</Label>
          <Input id={\`\${uid}-name\`} />
          <Label id="g">Group</Label>
          <div role="group" aria-labelledby="h g" />
          <Label id={labelId}>Colours</Label>
          <div role="radiogroup" aria-labelledby={labelId} />
          {/* a11y-ignore: decorative */}
          <Label>Decorative</Label>
        </div>
      );`);
    expect(r).toEqual({ unnamed: [], dangling: [] });
  });

  it("flags a literal htmlFor without a matching id", () => {
    const r = check(`const a = <div><Label htmlFor="name">Name</Label><Input id="nmae" /></div>;`);
    expect(r.dangling).toHaveLength(1);
  });
});
