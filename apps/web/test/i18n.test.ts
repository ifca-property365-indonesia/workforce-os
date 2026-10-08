import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { NAMESPACES } from "@/i18n/namespaces";

/**
 * The i18n "lint": fails on hard-coded UI strings, on translation keys that do not exist,
 * on id/en catalogs that drift apart, and on server errors without a translated code.
 * Escape hatch for a deliberate literal (brand names, code samples): a `i18n-ignore` comment on the line or the line above.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const MSG = path.join(ROOT, "messages");
const LOCALES = ["en", "id"] as const;

type Tree = { [k: string]: string | Tree };

function load(locale: string): Record<string, Tree> {
  return Object.fromEntries(NAMESPACES.map((ns) => [ns, JSON.parse(readFileSync(path.join(MSG, locale, `${ns}.json`), "utf8")) as Tree]));
}

function flatten(t: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(t)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}

const catalogs = Object.fromEntries(LOCALES.map((l) => [l, flatten(load(l) as unknown as Tree)])) as Record<(typeof LOCALES)[number], Map<string, string>>;

/** ICU argument names, e.g. {name}, {count, plural, ...} → name, count */
function args(msg: string): string[] {
  const out = new Set<string>();
  const re = /\{\s*([A-Za-z_][\w]*)\s*(?:,|\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(msg))) out.add(m[1]!);
  return [...out].sort();
}

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(f) ? [p] : [];
  });
}

const UI_ATTRS = new Set(["placeholder", "title", "alt", "aria-label", "aria-description", "label", "description", "tooltip", "content"]);
const UI_PROPS = new Set(["label", "title", "description", "placeholder", "text", "hint", "help", "message", "empty", "heading", "subtitle", "caption"]);
const UI_CALLS = new Set(["toast", "toast.success", "toast.error", "toast.warning", "toast.info", "toast.message", "confirm", "alert", "prompt"]);
/** literals that are the same in every language */
const ALLOWED = new Set(["Workforce OS", "Claude", "Google", "MCP", "SMTP", "TLS", "IDR", "USD", "OK", "PDF", "DOCX", "MD", "API", "SSE", "cron", "UTC"]);
const HAS_LETTER = /\p{L}/u;

function ignored(sf: ts.SourceFile, node: ts.Node): boolean {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  const lines = sf.text.split("\n");
  return /i18n-ignore/.test(lines[line] ?? "") || /i18n-ignore/.test(lines[line - 1] ?? "");
}

function calleeName(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return `${calleeName(e.expression)}.${e.name.text}`;
  return "";
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function scan() {
  const hardcoded: Finding[] = [];
  const usedKeys: Finding[] = [];
  const dynamicPrefixes: Finding[] = [];
  const badErrors: Finding[] = [];
  for (const file of files(SRC, /\.(tsx?|ts)$/)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const rel = path.relative(ROOT, file);
    const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    // translator variables: const t = useTranslations("ns") / await getTranslations("ns")
    const translators = new Map<string, string>();
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let init: ts.Expression = node.initializer;
        if (ts.isAwaitExpression(init)) init = init.expression;
        if (ts.isCallExpression(init) && ["useTranslations", "getTranslations"].includes(calleeName(init.expression))) {
          const a = init.arguments[0];
          translators.set(node.name.text, a && ts.isStringLiteral(a) ? `${a.text}.` : a && ts.isObjectLiteralExpression(a) ? "?" : "");
        }
      }
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        const base = name.replace(/\.(rich|markup|raw|has)$/, "");
        if (translators.has(base) && translators.get(base) !== "?") {
          const a = node.arguments[0];
          const prefix = translators.get(base)!;
          if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) usedKeys.push({ file: rel, line: at(node), text: prefix + a.text });
          else if (a && ts.isTemplateExpression(a)) dynamicPrefixes.push({ file: rel, line: at(node), text: prefix + a.head.text });
        }
        if (UI_CALLS.has(name) && !ignored(sf, node)) {
          for (const a of node.arguments) {
            if ((ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isTemplateExpression(a)) && HAS_LETTER.test(a.getText(sf)) && !ALLOWED.has(a.getText(sf).slice(1, -1))) {
              hardcoded.push({ file: rel, line: at(a), text: `${name}(${a.getText(sf).slice(0, 60)})` });
            }
          }
        }
      }
      if (ts.isCallExpression(node) && calleeName(node.expression) === "notFound" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        usedKeys.push({ file: rel, line: at(node), text: `errors.${node.arguments[0].text}` });
      }
      if (ts.isNewExpression(node) && calleeName(node.expression) === "HttpError" && !ignored(sf, node)) {
        const extra = node.arguments?.[2];
        const code = extra && ts.isObjectLiteralExpression(extra)
          ? extra.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === "code")
          : undefined;
        if (!code || !ts.isStringLiteral(code.initializer)) badErrors.push({ file: rel, line: at(node), text: node.getText(sf).slice(0, 80) });
        else usedKeys.push({ file: rel, line: at(node), text: `errors.${code.initializer.text}` });
      }
      // UI strings in object literals, e.g. tabs = [{ label: "General" }]
      if (file.endsWith(".tsx") && ts.isPropertyAssignment(node) && UI_PROPS.has(node.name.getText(sf).replace(/["']/g, "")) && !ignored(sf, node)) {
        const v = node.initializer;
        if ((ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) && HAS_LETTER.test(v.text) && !ALLOWED.has(v.text)) {
          hardcoded.push({ file: rel, line: at(node), text: `${node.name.getText(sf)}: "${v.text.slice(0, 50)}"` });
        }
      }
      if (file.endsWith(".tsx")) {
        if (ts.isJsxText(node) && HAS_LETTER.test(node.text) && !ALLOWED.has(node.text.trim()) && !ignored(sf, node)) {
          hardcoded.push({ file: rel, line: at(node), text: node.text.trim().slice(0, 60) });
        }
        if (ts.isJsxAttribute(node) && UI_ATTRS.has(node.name.getText(sf)) && node.initializer && !ignored(sf, node)) {
          const init = node.initializer;
          const lit = ts.isStringLiteral(init) ? init : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression) ? init.expression : null;
          if (lit && HAS_LETTER.test(lit.text) && !ALLOWED.has(lit.text)) hardcoded.push({ file: rel, line: at(node), text: `${node.name.getText(sf)}="${lit.text.slice(0, 50)}"` });
        }
        // string literals rendered as children: {"text"} or {cond ? "a" : "b"}
        if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent) && !ignored(sf, node)) {
          const lits: ts.StringLiteral[] = [];
          const collect = (e: ts.Expression) => {
            if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) lits.push(e as ts.StringLiteral);
            else if (ts.isConditionalExpression(e)) {
              collect(e.whenTrue);
              collect(e.whenFalse);
            } else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
              collect(e.right);
            } else if (ts.isParenthesizedExpression(e)) collect(e.expression);
          };
          collect(node.expression);
          for (const l of lits) if (HAS_LETTER.test(l.text) && !ALLOWED.has(l.text)) hardcoded.push({ file: rel, line: at(l), text: `{"${l.text.slice(0, 50)}"}` });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { hardcoded, usedKeys, dynamicPrefixes, badErrors };
}

const result = scan();
const fmt = (fs: Finding[]) => fs.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");

describe("i18n catalogs", () => {
  it("every namespace file exists for every locale and is listed", () => {
    for (const l of LOCALES) {
      const onDisk = readdirSync(path.join(MSG, l)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
      expect(onDisk).toEqual([...NAMESPACES].sort());
    }
  });

  it("id and en have exactly the same keys", () => {
    const en = [...catalogs.en.keys()].sort();
    const id = [...catalogs.id.keys()].sort();
    expect(id.filter((k) => !catalogs.en.has(k)), "keys only in id").toEqual([]);
    expect(en.filter((k) => !catalogs.id.has(k)), "keys only in en (untranslated)").toEqual([]);
  });

  it("no message is empty and placeholders match between languages", () => {
    const problems: string[] = [];
    for (const [k, en] of catalogs.en) {
      const id = catalogs.id.get(k);
      if (!en.trim() || !id?.trim()) problems.push(`${k}: empty`);
      else if (args(en).join() !== args(id).join()) problems.push(`${k}: en {${args(en)}} vs id {${args(id)}}`);
    }
    expect(problems).toEqual([]);
  });
});

describe("i18n usage in src", () => {
  it("has no hard-coded UI strings", () => {
    expect(fmt(result.hardcoded)).toBe("");
  });

  it("uses only keys that exist", () => {
    expect(fmt(result.usedKeys.filter((k) => !catalogs.en.has(k.text)))).toBe("");
  });

  it("dynamic keys point at an existing group", () => {
    expect(fmt(result.dynamicPrefixes.filter((k) => ![...catalogs.en.keys()].some((x) => x.startsWith(k.text))))).toBe("");
  });

  it("every HttpError carries a translated code", () => {
    expect(fmt(result.badErrors)).toBe("");
  });
});
