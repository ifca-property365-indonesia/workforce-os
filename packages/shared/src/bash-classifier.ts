import { createRequire } from "node:module";
import path from "node:path";

/**
 * Bash command classifier for Workspace mode (runs before every Bash tool call).
 *
 * The OS sandbox (per-run systemd unit: no host network, read-only system, own UID) decides what a command
 * CAN do. This classifier decides what may run WITHOUT a human: only commands it can prove are local and
 * reversible inside the workspace. Everything else, including anything it cannot parse or understand,
 * goes to an approval card with the exact command (fail closed).
 *
 * Parsing uses mvdan/sh (the parser behind shfmt) so `;`, `&&`, `||`, pipes, `$()`, backticks, subshells,
 * functions, heredocs and redirections are real syntax, not regex guesses.
 */

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { syntax } = require("mvdan-sh") as { syntax: any };

export type BashDecision = "allow" | "approval";
export type BashCategory =
  | "read" // inspects files or state only
  | "local" // builds, tests, edits or git operations inside the workspace
  | "network" // talks to another host
  | "publish" // publishes, deploys, pushes
  | "escape" // writes or changes things outside the workspace
  | "config" // changes git config/hooks, shell environment or aliases
  | "process" // kills or controls other processes / the system
  | "interpreter" // runs inline code that cannot be inspected
  | "sensitive" // reads secrets (process environments, keys)
  | "unknown"; // not understood → approval

export interface BashCommandInfo {
  name: string;
  args: string[];
  category: BashCategory;
  reason?: string;
}

export interface BashClassification {
  decision: BashDecision;
  /** the most severe category found */
  category: BashCategory;
  reasons: string[];
  commands: BashCommandInfo[];
  /** git hooks/repo scripts are disabled for anything the platform runs on the agent's behalf */
  hooksDisabled: true;
}

export interface BashContext {
  /** the run has read untrusted content: only read-only commands may run without approval */
  tainted?: boolean;
}

const SEVERITY: Record<BashCategory, number> = {
  read: 0,
  local: 1,
  interpreter: 5,
  unknown: 5,
  config: 6,
  sensitive: 6,
  escape: 7,
  process: 7,
  network: 8,
  publish: 9,
};

const DYN = "\u0000dyn";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

function nodeType(n: Node): string {
  return syntax.NodeType(n);
}

// ---------------------------------------------------------------------------
// Operator codes are numbers in mvdan-sh; calibrate them by parsing samples.
// ---------------------------------------------------------------------------

const REDIR = (() => {
  const ops: Record<string, number> = {};
  for (const [name, src] of [
    [">", "a >f"],
    [">>", "a >>f"],
    ["<", "a <f"],
    ["<>", "a <>f"],
    [">&", "a >&2"],
    ["<&", "a <&3"],
    [">|", "a >|f"],
    ["&>", "a &>f"],
    ["&>>", "a &>>f"],
    ["<<", "a <<E\nx\nE"],
    ["<<-", "a <<-E\nx\nE"],
    ["<<<", "a <<<x"],
  ] as const) {
    ops[name] = syntax.NewParser().Parse(src, "calibrate").Stmts[0].Redirs[0].Op;
  }
  return ops;
})();
const WRITE_REDIRS = new Set([REDIR[">"], REDIR[">>"], REDIR["<>"], REDIR[">|"], REDIR["&>"], REDIR["&>>"]]);
const HEREDOC_REDIRS = new Set([REDIR["<<"], REDIR["<<-"], REDIR["<<<"]]);
const DUP_REDIRS = new Set([REDIR[">&"], REDIR["<&"]]);

// ---------------------------------------------------------------------------
// Words: static value when fully literal, else DYN (computed at run time)
// ---------------------------------------------------------------------------

function staticWord(w: Node): string | null {
  if (!w) return null;
  let out = "";
  for (const p of w.Parts) {
    const t = nodeType(p);
    if (t === "Lit") out += p.Value.replace(/\\\n/g, "").replace(/\\(.)/g, "$1");
    else if (t === "SglQuoted") {
      if (p.Dollar) return null; // $'…' escapes can hide content
      out += p.Value;
    } else if (t === "DblQuoted") {
      for (const q of p.Parts) {
        if (nodeType(q) === "Lit") out += q.Value.replace(/\\\n/g, "").replace(/\\([$`"\\])/g, "$1");
        else return null;
      }
    } else return null;
  }
  return out;
}

/** Unquoted literal that contains glob or brace characters (expands to unknown paths). */
function hasGlob(w: Node): boolean {
  return w.Parts.some((p: Node) => (nodeType(p) === "Lit" && /[*?[]/.test(p.Value)) || nodeType(p) === "BraceExp" || nodeType(p) === "ExtGlob");
}

// ---------------------------------------------------------------------------
// Paths (relative to the workspace root, which is the working directory of every command)
// ---------------------------------------------------------------------------

const WS = "/__workspace__";

/** Inside the workspace (or the run's private /tmp) after normalising `..`. */
function insideWorkspace(p: string): boolean {
  if (p === DYN) return false;
  if (p === "/dev/null" || p === "/dev/stdout" || p === "/dev/stderr") return true;
  if (p.startsWith("~")) return false;
  const abs = path.posix.isAbsolute(p) ? path.posix.normalize(p) : path.posix.normalize(path.posix.join(WS, p));
  if (abs === "/tmp" || abs.startsWith("/tmp/")) return true; // private per run (PrivateTmp)
  return abs === WS || abs.startsWith(`${WS}/`);
}

function protectedRepoPath(p: string): boolean {
  const n = path.posix.normalize(p);
  return /(^|\/)\.git\/(hooks|config|info\/attributes)(\/|$)/.test(n) || /(^|\/)\.git\/?$/.test(n) || /(^|\/)\.gitmodules$/.test(n);
}

const SENSITIVE_PATH =
  /(^|\/)proc\/[^/]+\/(environ|mem|maps|auxv)$|^\/etc\/(shadow|gshadow|sudoers)|(^|\/)\.ssh(\/|$)|(^|\/)\.aws(\/|$)|(^|\/)\.config\/gcloud|(^|\/)\.kube\/config|(^|\/)\.netrc$|(^|\/)\.npmrc$|(^|\/)\.git-credentials$|^\/root(\/|$)|^\/var\/run\/secrets|^\/run\/secrets/;

function sensitive(p: string): boolean {
  return SENSITIVE_PATH.test(p) || SENSITIVE_PATH.test(path.posix.normalize(p));
}

// ---------------------------------------------------------------------------
// Command tables
// ---------------------------------------------------------------------------

const READ = new Set([
  "ls", "ll", "cat", "head", "tail", "less", "more", "wc", "grep", "egrep", "fgrep", "rg", "ag", "fd", "tree", "pwd", "echo",
  "printf", "true", "false", "test", "[", "[[", "diff", "cmp", "sort", "uniq", "cut", "tr", "jq", "yq", "stat", "file", "du", "df",
  "basename", "dirname", "realpath", "readlink", "which", "type", "whoami", "id", "date", "printenv", "uname", "nl", "column",
  "sha256sum", "sha1sum", "md5sum", "base64", "xxd", "od", "hexdump", "strings", "seq", "sleep", "comm", "join", "paste", "fold",
  "fmt", "rev", "tac", "expr", "bc", "dirs", "hash", "help", "man", "pdftotext", "pdfinfo", "pdfimages", "tesseract",
]);

const LOCAL_WRITE = new Set(["mkdir", "touch", "cp", "mv", "chmod", "truncate", "patch", "gzip", "gunzip", "zip", "split", "install"]);

const BUILD_TOOLS = new Set([
  "make", "tsc", "vitest", "jest", "mocha", "eslint", "prettier", "biome", "pytest", "ruff", "mypy", "black", "flake8", "rustc",
  "gcc", "g++", "clang", "javac", "pandoc", "soffice", "libreoffice", "qpdf", "convert", "magick", "tsx", "ts-node", "next", "vite",
  "webpack", "esbuild", "rollup", "turbo", "nx",
]);

const NETWORK = new Set(["curl", "wget", "aria2c", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "ssh", "scp", "rsync", "ping", "dig", "nslookup", "host", "traceroute", "mtr", "openssl", "http", "httpie", "lynx", "w3m"]);

const PUBLISH = new Set(["docker", "podman", "kubectl", "helm", "terraform", "pulumi", "ansible", "ansible-playbook", "gcloud", "aws", "az", "vercel", "netlify", "fly", "flyctl", "heroku", "gh", "glab", "firebase", "wrangler", "serverless", "sls", "twine", "eas", "expo"]);

const PROCESS = new Set([
  "kill", "pkill", "killall", "systemctl", "service", "shutdown", "reboot", "halt", "poweroff", "crontab", "at", "mount", "umount",
  "iptables", "nft", "ufw", "sudo", "doas", "su", "chown", "chgrp", "renice", "nohup", "disown", "setsid", "chroot", "unshare",
  "nsenter", "dd", "mkfs", "fdisk", "useradd", "usermod", "passwd", "visudo", "insmod", "modprobe", "sysctl", "strace", "gdb",
]);

const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh", "fish", "busybox"]);
const INTERPRETERS = new Set(["python", "python3", "python2", "node", "nodejs", "perl", "ruby", "php", "lua", "Rscript", "osascript", "pwsh", "powershell", "tclsh", "groovy", "julia"]);

/** Commands that run another command: classify what they run. */
const WRAPPERS = new Set(["env", "nice", "time", "timeout", "stdbuf", "ionice", "command", "builtin", "exec", "xvfb-run", "unbuffer"]);

const CONFIG_BUILTINS = new Set(["alias", "unalias", "enable", "trap", "shopt", "complete", "bind"]);
const DANGEROUS_VARS =
  /^(PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|BASH_ENV|ENV|PROMPT_COMMAND|IFS|PS4|SHELLOPTS|BASHOPTS|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|GIT_[A-Z_]+|HTTPS?_PROXY|https?_proxy|ALL_PROXY|NO_PROXY|no_proxy|ANTHROPIC_[A-Z_]+|CLAUDE_[A-Z_]+|HOME|XDG_CONFIG_HOME|npm_config_[a-z_]+)$/;

const GIT_LOCAL = new Set([
  "status", "diff", "log", "show", "add", "commit", "restore", "checkout", "switch", "branch", "tag", "stash", "rev-parse", "ls-files",
  "ls-tree", "blame", "grep", "reset", "merge", "rebase", "cherry-pick", "revert", "mv", "rm", "init", "describe", "shortlog", "reflog",
  "cat-file", "rev-list", "merge-base", "name-rev", "whatchanged", "format-patch", "apply", "am", "notes", "bisect", "help", "version",
  "var", "count-objects", "fsck", "check-ignore", "diff-tree", "diff-files", "diff-index", "show-ref", "for-each-ref", "symbolic-ref",
  "update-index", "write-tree", "commit-tree", "hash-object",
]);
const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "describe", "shortlog", "reflog", "cat-file", "rev-list", "merge-base", "name-rev", "help", "version", "show-ref", "for-each-ref", "diff-tree", "check-ignore", "count-objects"]);
const GIT_NETWORK = new Set(["push", "fetch", "pull", "clone", "ls-remote", "remote", "submodule", "send-email", "request-pull", "daemon", "svn", "p4", "archive", "http-push", "upload-pack", "receive-pack", "credential", "credential-store", "lfs"]);

const PKG = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx", "poetry", "uv", "composer", "bundle", "cargo", "go", "gem", "dotnet", "mvn", "gradle", "deno"]);
const PKG_INSTALL = new Set(["install", "i", "add", "ci", "update", "upgrade", "up", "remove", "rm", "uninstall", "un", "dedupe", "prune", "fetch", "get", "sync", "lock", "restore", "require", "dlx", "x", "create", "init"]);
const PKG_PUBLISH = new Set(["publish", "login", "logout", "adduser", "deprecate", "owner", "unpublish", "dist-tag", "token", "access", "team", "org", "hook", "star", "yank", "push"]);
/** package-manager options that take a value (the value is not the subcommand) */
const PKG_VALUE_OPTS = new Set(["--filter", "-F", "-C", "--dir", "--cwd", "--prefix", "--workspace", "--reporter", "--loglevel", "--registry", "--config", "-c", "--manifest-path", "--package", "-p", "--target", "--features"]);
const PKG_LOCAL = new Set(["test", "t", "run", "run-script", "lint", "build", "typecheck", "check", "fmt", "format", "vet", "start", "dev", "exec", "ls", "list", "outdated", "why", "explain", "view", "info", "show", "audit", "pack", "version", "--version", "-v", "help", "doc", "bench", "clippy", "tidy", "mod", "env"]);

// ---------------------------------------------------------------------------
// Classification of one simple command
// ---------------------------------------------------------------------------

interface Ctx {
  tainted: boolean;
  out: BashCommandInfo[];
  depth: number;
}

function add(ctx: Ctx, name: string, args: string[], category: BashCategory, reason?: string): void {
  ctx.out.push({ name, args: args.map((a) => (a === DYN ? "$(…)" : a)), category, reason });
}

/** Running repository code: fine in a clean run (the sandbox contains it), needs approval once tainted. */
function runsCode(ctx: Ctx, name: string, args: string[], what = "runs repository code"): void {
  if (ctx.tainted) add(ctx, name, args, "unknown", `${what} after untrusted content was read`);
  else add(ctx, name, args, "local");
}

function operands(args: string[]): number[] {
  const idx: number[] = [];
  let endOfOpts = false;
  args.forEach((a, i) => {
    if (i === 0) return;
    if (!endOfOpts && a === "--") {
      endOfOpts = true;
      return;
    }
    if (!endOfOpts && a.startsWith("-") && a !== "-") return;
    idx.push(i);
  });
  return idx;
}

/** Every operand must be a static path inside the workspace and not git internals. Returns false (and records why) otherwise. */
function checkWritePaths(ctx: Ctx, name: string, args: string[], words: Node[], idx: number[]): boolean {
  for (const i of idx) {
    const v = args[i];
    if (v === undefined) continue;
    if (v === DYN) {
      add(ctx, name, args, "unknown", `${name}: a target path is computed at run time and cannot be checked`);
      return false;
    }
    if (name === "rm" && words[i] && hasGlob(words[i])) {
      add(ctx, name, args, "unknown", "rm with a glob pattern");
      return false;
    }
    if (protectedRepoPath(v)) {
      add(ctx, name, args, "config", `${name} touches git hooks or config (${v})`);
      return false;
    }
    if (!insideWorkspace(v)) {
      add(ctx, name, args, "escape", `${name} writes outside the workspace (${v})`);
      return false;
    }
  }
  return true;
}

function classifyGit(ctx: Ctx, args: string[]): void {
  let i = 1;
  while (i < args.length && args[i]!.startsWith("-")) {
    const a = args[i]!;
    if (a === "-c" || a.startsWith("--config-env") || a.startsWith("--exec-path")) {
      return add(ctx, "git", args, "config", "git -c / --exec-path overrides configuration (hooks, ssh command, aliases)");
    }
    if (a === "-C" || a === "--git-dir" || a === "--work-tree") {
      const target = args[i + 1] ?? "";
      if (!insideWorkspace(target)) return add(ctx, "git", args, "escape", `git operates on a repository outside the workspace (${target === DYN ? "computed" : target})`);
      i += 2;
      continue;
    }
    if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) {
      const target = a.split("=")[1] ?? "";
      if (!insideWorkspace(target)) return add(ctx, "git", args, "escape", `git operates on a repository outside the workspace (${target})`);
    }
    i++;
  }
  const sub = args[i] ?? "";
  if (sub === DYN) return add(ctx, "git", args, "unknown", "git subcommand is computed at run time");
  if (sub === "config") {
    const rest = args.slice(i + 1);
    const readOnly = rest.some((a) => ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin"].includes(a));
    return add(ctx, "git", args, readOnly ? "read" : "config", readOnly ? undefined : "changes git configuration");
  }
  if (sub === "hook") return add(ctx, "git", args, "config", "runs or changes git hooks");
  if (sub === "remote" && (args[i + 1] === undefined || args[i + 1] === "-v" || args[i + 1] === "get-url")) return add(ctx, "git", args, "read");
  if (GIT_NETWORK.has(sub)) {
    return sub === "push"
      ? add(ctx, "git", args, "publish", "git push: use the git_push tool (the platform pushes after approval)")
      : add(ctx, "git", args, "network", `git ${sub} talks to a remote`);
  }
  if (["worktree", "clean", "filter-branch", "gc", "prune", "replace"].includes(sub)) {
    return add(ctx, "git", args, "unknown", `git ${sub} can remove work or write outside the repository`);
  }
  if (sub === "init" && args.slice(i + 1).some((a) => a.startsWith("--template") || a.startsWith("--separate-git-dir"))) {
    return add(ctx, "git", args, "config", "git init with a template or a separate git dir");
  }
  if (GIT_LOCAL.has(sub)) return add(ctx, "git", args, GIT_READ.has(sub) ? "read" : "local");
  add(ctx, "git", args, "unknown", `unknown git subcommand ${sub || "(none)"}`);
}

function classifyPkg(ctx: Ctx, name: string, args: string[]): void {
  if (["npx", "pnpx", "bunx"].includes(name)) return add(ctx, name, args, "network", `${name} may download and run a package`);
  const ops: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (PKG_VALUE_OPTS.has(a)) {
      if (["-C", "--dir", "--cwd", "--prefix"].includes(a) && !insideWorkspace(args[i + 1] ?? "")) {
        return add(ctx, name, args, "escape", `${name} ${a} points outside the workspace`);
      }
      i++;
      continue;
    }
    if (/^--(dir|cwd|prefix)=/.test(a) && !insideWorkspace(a.split("=")[1] ?? "")) return add(ctx, name, args, "escape", `${name} ${a} points outside the workspace`);
    if (!a.startsWith("-")) ops.push(a);
  }
  const sub = ops[0] ?? "";
  if (sub === DYN) return add(ctx, name, args, "unknown", "subcommand computed at run time");
  if (name === "pip" || name === "pip3" || name === "pipx") {
    if (["list", "show", "freeze", "check", "help"].includes(sub) || args.includes("--version")) return add(ctx, name, args, "read");
    return add(ctx, name, args, "network", `${name} ${sub} downloads or changes packages`);
  }
  if (PKG_PUBLISH.has(sub) || (name === "cargo" && sub === "publish")) return add(ctx, name, args, "publish", `${name} ${sub} publishes or changes registry state`);
  if (name === "go" && (sub === "get" || sub === "install")) return add(ctx, name, args, "network", `go ${sub} downloads modules`);
  if (PKG_INSTALL.has(sub)) return add(ctx, name, args, "network", `${name} ${sub} downloads or changes dependencies`);
  if (name === "yarn" && ops.length === 0) return add(ctx, name, args, "network", "yarn without arguments installs dependencies");
  if (sub === "config") {
    return ["set", "delete", "edit", "unset"].includes(ops[1] ?? "") ? add(ctx, name, args, "config", `changes ${name} configuration`) : add(ctx, name, args, "read");
  }
  if (PKG_LOCAL.has(sub) || ["build", "test", "check", "vet", "fmt", "clippy", "bench", "run"].includes(sub)) return runsCode(ctx, name, args, "runs repository scripts");
  if (["pnpm", "yarn", "bun"].includes(name) && BUILD_TOOLS.has(sub)) return runsCode(ctx, name, args, `runs ${sub}`);
  if (name === "yarn" && sub) return runsCode(ctx, name, args, "runs repository scripts"); // `yarn build` = run script
  add(ctx, name, args, "unknown", `${name} ${sub}`.trim());
}

function interpreterInline(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (["-c", "-e", "--eval", "-E", "--command", "-p", "--print", "-r", "--exec"].includes(a)) return args[i + 1] ?? DYN;
    if (/^-[a-zA-Z]*c$/.test(a) && !a.startsWith("--")) return args[i + 1] ?? DYN; // e.g. bash -lc, sh -xc
  }
  return null;
}

function classifySimple(ctx: Ctx, words: Node[], assigns: Node[], redirs: Node[]): void {
  const args = words.map((w) => staticWord(w) ?? DYN);

  for (const a of assigns) {
    const name = a.Name?.Value ?? "";
    if (DANGEROUS_VARS.test(name)) add(ctx, `${name}=`, [], "config", `sets ${name}, which changes how later commands run`);
  }

  for (const r of redirs) {
    if (HEREDOC_REDIRS.has(r.Op) || DUP_REDIRS.has(r.Op)) continue;
    const target = staticWord(r.Word);
    if (target && /^\/dev\/(tcp|udp)\//.test(target)) {
      add(ctx, "<>", [target], "network", `opens a network connection (${target})`);
      continue;
    }
    if (WRITE_REDIRS.has(r.Op)) {
      if (target === null) add(ctx, ">", ["$(…)"], "unknown", "redirects output to a path computed at run time");
      else if (protectedRepoPath(target)) add(ctx, ">", [target], "config", `writes git hooks or config (${target})`);
      else if (!insideWorkspace(target)) add(ctx, ">", [target], "escape", `writes outside the workspace (${target})`);
    } else if (target && sensitive(target)) {
      add(ctx, "<", [target], "sensitive", `reads ${target}`);
    }
  }

  if (args.length === 0) return; // pure assignment or redirection

  const first = args[0]!;
  if (first === DYN) return add(ctx, "$(…)", args, "unknown", "the command name is computed at run time");
  const name = path.posix.basename(first);

  for (const a of args.slice(1)) {
    if (a !== DYN && sensitive(a.replace(/^[^=/]+=/, ""))) return add(ctx, name, args, "sensitive", `reads ${a}`);
  }

  // workspace scripts (`./build.sh`, `scripts/x`, `node_modules/.bin/vitest`): write-then-run, contained by the sandbox
  if (first.includes("/") && !path.posix.isAbsolute(first)) {
    if (!insideWorkspace(first)) return add(ctx, name, args, "escape", `runs ${first} outside the workspace`);
    return runsCode(ctx, name, args, "runs a workspace script");
  }

  if (WRAPPERS.has(name)) {
    if (name === "env" && args.slice(1).every((a) => a !== DYN && (a.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)))) {
      for (const a of args.slice(1)) if (DANGEROUS_VARS.test(a.split("=")[0]!)) return add(ctx, name, args, "config", `sets ${a.split("=")[0]}`);
      return add(ctx, name, args, "read");
    }
    let i = 1;
    while (i < args.length) {
      const a = args[i]!;
      if (a === DYN) return add(ctx, name, args, "unknown", `${name} runs a command computed at run time`);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        const v = a.split("=")[0]!;
        if (DANGEROUS_VARS.test(v)) add(ctx, `${v}=`, [], "config", `sets ${v} for the command`);
        i++;
      } else if (a.startsWith("-")) {
        i += ["-u", "-C", "-S", "-n", "-k", "-s", "--signal", "--kill-after", "--chdir"].includes(a) ? 2 : 1;
        if (a === "-C" || a === "--chdir") {
          const d = args[i - 1] ?? "";
          if (!insideWorkspace(d)) return add(ctx, name, args, "escape", `changes directory outside the workspace (${d})`);
        }
      } else if ((name === "timeout" || name === "nice") && /^[+-]?\d+(\.\d+)?[smhd]?$/.test(a)) {
        i++;
      } else break;
    }
    const inner = words.slice(i);
    if (!inner.length) return add(ctx, name, args, "read");
    return classifySimple(ctx, inner, [], []);
  }

  if (name === "eval") {
    if (args.slice(1).some((a) => a === DYN)) return add(ctx, name, args, "interpreter", "eval of text computed at run time");
    return classifyScript(ctx, args.slice(1).join(" "), "eval");
  }
  if (name === "source" || name === ".") {
    const f = args[1] ?? "";
    if (!insideWorkspace(f)) return add(ctx, name, args, "escape", `sources ${f === DYN ? "a computed path" : f || "a file"} outside the workspace`);
    return runsCode(ctx, name, args, "sources a workspace script");
  }
  if (name === "xargs") {
    let i = 1;
    while (i < args.length && args[i]!.startsWith("-")) i += ["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"].includes(args[i]!) ? 2 : 1;
    if (i >= args.length) return add(ctx, name, args, "read"); // defaults to echo
    if (args.slice(i).some((a) => a === DYN)) return add(ctx, name, args, "unknown", "xargs runs a computed command");
    // the command's extra arguments come from stdin: path checks cannot see them
    const inner = words.slice(i);
    const innerName = path.posix.basename(args[i]!);
    if (LOCAL_WRITE.has(innerName) || ["rm", "rmdir", "ln", "tee", "sed", "tar", "unzip"].includes(innerName)) {
      return add(ctx, name, args, "unknown", `xargs ${innerName}: target paths come from input and cannot be checked`);
    }
    return classifySimple(ctx, inner, [], []);
  }
  if (name === "cd" || name === "pushd") {
    const t = args[1];
    if (t === undefined) return add(ctx, name, args, "escape", "cd to the home directory");
    if (!insideWorkspace(t)) return add(ctx, name, args, "escape", `changes directory outside the workspace (${t === DYN ? "computed" : t})`);
    return add(ctx, name, args, "read");
  }
  if (["export", "declare", "local", "readonly", "typeset"].includes(name)) {
    for (const a of args.slice(1)) {
      if (a === DYN) return add(ctx, name, args, "unknown", "declares a variable computed at run time");
      if (DANGEROUS_VARS.test(a.split("=")[0]!)) return add(ctx, name, args, "config", `sets ${a.split("=")[0]}`);
    }
    return add(ctx, name, args, "read");
  }
  if (["set", "unset", "shift", "return", "exit", "wait", "read", "getopts", "let", "ulimit", "umask", "popd", ":"].includes(name)) {
    return add(ctx, name, args, "read");
  }
  if (CONFIG_BUILTINS.has(name)) return add(ctx, name, args, "config", `${name} changes how later commands run`);

  if (SHELLS.has(name)) {
    const inline = interpreterInline(args);
    if (inline === DYN) return add(ctx, name, args, "interpreter", `${name} -c with a script computed at run time`);
    if (inline !== null) return classifyScript(ctx, inline, name);
    const file = args.slice(1).find((a) => !a.startsWith("-"));
    if (!file) return add(ctx, name, args, "interpreter", `${name} reads its script from standard input (pipe or heredoc)`);
    if (!insideWorkspace(file)) return add(ctx, name, args, "escape", `${name} runs ${file === DYN ? "a computed path" : file} outside the workspace`);
    return runsCode(ctx, name, args, "runs a workspace script");
  }

  if (INTERPRETERS.has(name)) {
    if (name.startsWith("python") && args[1] === "-m") {
      const mod = args[2] ?? "";
      if (["pytest", "unittest", "mypy", "ruff", "black", "flake8", "py_compile", "compileall"].includes(mod)) return runsCode(ctx, name, args, `runs python -m ${mod}`);
      if (mod === "json.tool") return add(ctx, name, args, "read");
      if (mod === "pip" || mod === "venv" || mod === "ensurepip") return add(ctx, name, args, mod === "venv" ? "local" : "network", mod === "venv" ? undefined : `python -m ${mod} installs packages`);
      if (["http.server", "smtplib", "ftplib", "telnetlib", "smtpd", "webbrowser"].includes(mod)) return add(ctx, name, args, "network", `python -m ${mod}`);
      return add(ctx, name, args, "unknown", `python -m ${mod}`);
    }
    if (interpreterInline(args) !== null) return add(ctx, name, args, "interpreter", `${name} runs inline code that cannot be inspected`);
    const file = args.slice(1).find((a) => !a.startsWith("-"));
    if (!file) return add(ctx, name, args, "interpreter", `${name} reads code from standard input`);
    if (/^https?:/.test(file)) return add(ctx, name, args, "network", `${name} runs a remote script`);
    if (!insideWorkspace(file)) return add(ctx, name, args, "escape", `${name} runs ${file === DYN ? "a computed path" : file} outside the workspace`);
    return runsCode(ctx, name, args, "runs a workspace script");
  }

  if (name === "git") return classifyGit(ctx, args);
  if (PKG.has(name) || ["npx", "pnpx", "bunx"].includes(name)) return classifyPkg(ctx, name, args);
  if (NETWORK.has(name)) return add(ctx, name, args, "network", `${name} contacts another host`);
  if (PUBLISH.has(name)) return add(ctx, name, args, "publish", `${name} deploys or changes remote infrastructure`);
  if (PROCESS.has(name)) return add(ctx, name, args, "process", `${name} controls processes or the system`);

  if (name === "find") {
    const bad = args.findIndex((a) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls", "-fprint0"].includes(a));
    if (bad < 0) return add(ctx, name, args, "read");
    if (!args[bad]!.startsWith("-exec") && !args[bad]!.startsWith("-ok")) return add(ctx, name, args, "unknown", `find ${args[bad]} modifies files`);
    const end = args.findIndex((a, k) => k > bad && (a === ";" || a === "+"));
    const inner = words.slice(bad + 1, end < 0 ? undefined : end);
    const innerName = path.posix.basename(staticWord(inner[0]) ?? DYN);
    if (["rm", "rmdir", "mv", "cp", "chmod", "ln", "tee", "sed", "truncate"].includes(innerName)) {
      return add(ctx, name, args, "unknown", `find -exec ${innerName}: target paths come from find and cannot be checked`);
    }
    return classifySimple(ctx, inner, [], []);
  }
  if (name === "sed") {
    const script = args.slice(1).filter((a) => !a.startsWith("-")).join(" ");
    if (args.some((a) => a === DYN) && !args.some((a) => a === "-i" || a.startsWith("-i"))) return add(ctx, name, args, "read");
    if (/(^|[;\n{}])\s*[0-9,$/]*\s*[ewWrR](\s|$)|\/[gimp0-9]*e[gimp0-9]*(\s|;|$)/.test(script)) return add(ctx, name, args, "interpreter", "sed script executes commands or reads/writes other files");
    const inPlace = args.some((a) => a === "-i" || /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
    if (!inPlace) return add(ctx, name, args, "read");
    const ops = operands(args).filter((i) => !args.slice(1, i).some((a) => a === "-e" || a === "-f") || i > 1);
    if (!checkWritePaths(ctx, name, args, words, ops.slice(args.some((a) => a === "-e" || a === "-f") ? 0 : 1))) return;
    return add(ctx, name, args, "local");
  }
  if (name === "awk" || name === "gawk" || name === "mawk") {
    const prog = args.slice(1).find((a) => !a.startsWith("-")) ?? "";
    if (prog === DYN || /system\s*\(|\|\s*getline|getline\s*</.test(prog) || /print[f]?[^;}]*[|>]/.test(prog)) {
      return add(ctx, name, args, "interpreter", "awk program runs commands or writes files");
    }
    return add(ctx, name, args, "read");
  }
  if (name === "tee") return void (checkWritePaths(ctx, name, args, words, operands(args)) && add(ctx, name, args, "local"));
  if (name === "ln") {
    for (const i of operands(args)) {
      const v = args[i]!;
      if (!insideWorkspace(v) || protectedRepoPath(v)) {
        return add(ctx, name, args, "escape", `link points to or is created outside the workspace (${v === DYN ? "computed" : v})`);
      }
    }
    return add(ctx, name, args, "local");
  }
  if (name === "rm" || name === "rmdir") {
    const ops = operands(args);
    for (const i of ops) {
      const v = args[i]!;
      if (v !== DYN && ["", ".", "..", "*", "/", "~"].includes(v.replace(/\/+$/, "") || "/")) return add(ctx, name, args, "unknown", `removes ${v || "everything"}`);
    }
    return void (checkWritePaths(ctx, name, args, words, ops) && add(ctx, name, args, "local"));
  }
  if (name === "tar" || name === "unzip") {
    if (args.some((a) => /--to-command|--use-compress-program|^-I$|--checkpoint-action|--rsh-command|--info-script|--new-volume-script/.test(a))) {
      return add(ctx, name, args, "interpreter", `${name} option runs a command`);
    }
    if (args.some((a) => /^[a-z]+:\/\/|^[^/\s]+@[^:\s]+:/.test(a))) return add(ctx, name, args, "network", `${name} uses a remote archive`);
    if (args.some((a) => a === "-P" || a === "--absolute-names")) return add(ctx, name, args, "escape", `${name} keeps absolute paths`);
    const cIdx = args.findIndex((a) => a === "-C" || a === "--directory" || a === "-d");
    if (cIdx > 0 && !checkWritePaths(ctx, name, args, words, [cIdx + 1])) return;
    return add(ctx, name, args, "local");
  }
  if (LOCAL_WRITE.has(name)) {
    if (name === "chmod" && args.some((a) => /[ugo]*\+[rwx]*s|^[2-7][0-7]{3}$/.test(a))) return add(ctx, name, args, "process", "sets setuid/setgid bits");
    return void (checkWritePaths(ctx, name, args, words, operands(args)) && add(ctx, name, args, "local"));
  }
  if (READ.has(name)) return add(ctx, name, args, "read");
  if (BUILD_TOOLS.has(name)) return runsCode(ctx, name, args, `runs ${name}`);

  add(ctx, name, args, "unknown", `${name} is not a known safe command`);
}

// ---------------------------------------------------------------------------
// Walking the syntax tree
// ---------------------------------------------------------------------------

function walkStmts(ctx: Ctx, stmts: Node[]): void {
  for (const s of stmts ?? []) walkStmt(ctx, s);
}

/** Command and process substitutions run too: analyse them as commands. */
function walkWord(ctx: Ctx, w: Node): void {
  if (!w) return;
  for (const p of w.Parts ?? []) {
    const t = nodeType(p);
    if (t === "CmdSubst" || t === "ProcSubst") walkStmts(ctx, p.Stmts);
    else if (t === "DblQuoted") walkWord(ctx, p);
    else if (t === "ParamExp") {
      if (p.Exp?.Word) walkWord(ctx, p.Exp.Word);
      if (p.Repl?.Orig) walkWord(ctx, p.Repl.Orig);
      if (p.Repl?.With) walkWord(ctx, p.Repl.With);
    } else if (t === "ArithmExp") {
      // arithmetic can contain $(…) inside words; walk generically
      syntax.Walk(p, (n: Node) => {
        if (n && (nodeType(n) === "CmdSubst" || nodeType(n) === "ProcSubst")) walkStmts(ctx, n.Stmts);
        return true;
      });
    }
  }
}

function walkStmt(ctx: Ctx, s: Node): void {
  if (!s) return;
  for (const r of s.Redirs ?? []) {
    walkWord(ctx, r.Word);
    if (r.Hdoc) walkWord(ctx, r.Hdoc);
  }
  if (s.Coprocess) add(ctx, "coproc", [], "process", "starts a coprocess");
  if (s.Background) add(ctx, "&", [], "unknown", "runs a command in the background (it would outlive the review)");
  const cmd = s.Cmd;
  if (!cmd) return classifySimple(ctx, [], [], s.Redirs ?? []);
  const t = nodeType(cmd);
  switch (t) {
    case "CallExpr":
      for (const a of cmd.Assigns ?? []) walkWord(ctx, a.Value);
      for (const w of cmd.Args ?? []) walkWord(ctx, w);
      return classifySimple(ctx, cmd.Args ?? [], cmd.Assigns ?? [], s.Redirs ?? []);
    case "BinaryCmd":
      walkStmt(ctx, cmd.X);
      walkStmt(ctx, cmd.Y);
      return classifySimple(ctx, [], [], s.Redirs ?? []);
    case "Subshell":
    case "Block":
      walkStmts(ctx, cmd.Stmts);
      return classifySimple(ctx, [], [], s.Redirs ?? []);
    case "IfClause": {
      let c = cmd;
      while (c) {
        walkStmts(ctx, c.Cond);
        walkStmts(ctx, c.Then);
        c = c.Else;
      }
      return classifySimple(ctx, [], [], s.Redirs ?? []);
    }
    case "WhileClause":
      walkStmts(ctx, cmd.Cond);
      walkStmts(ctx, cmd.Do);
      return classifySimple(ctx, [], [], s.Redirs ?? []);
    case "ForClause":
      if (cmd.Loop && nodeType(cmd.Loop) === "WordIter") for (const w of cmd.Loop.Items ?? []) walkWord(ctx, w);
      walkStmts(ctx, cmd.Do);
      return classifySimple(ctx, [], [], s.Redirs ?? []);
    case "CaseClause":
      walkWord(ctx, cmd.Word);
      for (const item of cmd.Items ?? []) walkStmts(ctx, item.Stmts);
      return classifySimple(ctx, [], [], s.Redirs ?? []);
    case "FuncDecl":
      // the body is analysed as if it ran; calling the function by name is then a command like any other
      return walkStmt(ctx, cmd.Body);
    case "TimeClause":
      return walkStmt(ctx, cmd.Stmt);
    case "DeclClause": {
      const variant = cmd.Variant?.Value ?? "declare";
      for (const a of cmd.Args ?? []) {
        walkWord(ctx, a.Value);
        const n = a.Name?.Value ?? (a.Value ? staticWord(a.Value) : null);
        if (!n) return add(ctx, variant, [], "unknown", `${variant} of a name computed at run time`);
        if (DANGEROUS_VARS.test(n.split("=")[0]!)) return add(ctx, variant, [n], "config", `sets ${n.split("=")[0]}`);
      }
      return add(ctx, variant, [], "read");
    }
    case "TestClause":
    case "ArithmCmd":
    case "LetClause":
      syntax.Walk(cmd, (n: Node) => {
        if (n && (nodeType(n) === "CmdSubst" || nodeType(n) === "ProcSubst")) walkStmts(ctx, n.Stmts);
        return true;
      });
      return add(ctx, t, [], "read");
    case "CoprocClause":
      return add(ctx, "coproc", [], "process", "starts a coprocess");
    default:
      return add(ctx, t, [], "unknown", `unsupported shell construct ${t}`);
  }
}

function classifyScript(ctx: Ctx, src: string, origin: string): void {
  if (ctx.depth > 4) return add(ctx, origin, [], "unknown", "nested too deeply");
  let file: Node;
  try {
    file = syntax.NewParser().Parse(src, "cmd");
  } catch (e) {
    return add(ctx, origin, [], "unknown", `could not parse the command: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  ctx.depth++;
  try {
    walkStmts(ctx, file.Stmts);
  } finally {
    ctx.depth--;
  }
}

/** Classify one Bash tool call. Fail closed: anything not proven read-only/local needs approval. */
export function classifyBash(command: string, context: BashContext = {}): BashClassification {
  const result = (decision: BashDecision, category: BashCategory, reasons: string[], commands: BashCommandInfo[] = []): BashClassification => ({
    decision,
    category,
    reasons,
    commands,
    hooksDisabled: true,
  });
  if (!command.trim()) return result("approval", "unknown", ["empty command"]);
  if (command.length > 20_000) return result("approval", "unknown", ["command too long to review automatically"]);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(command)) {
    return result("approval", "unknown", ["contains control or bidirectional-override characters"]);
  }
  const ctx: Ctx = { tainted: !!context.tainted, out: [], depth: 0 };
  try {
    classifyScript(ctx, command, "bash");
  } catch (e) {
    return result("approval", "unknown", [`classifier error: ${String((e as Error)?.message ?? e).slice(0, 120)}`], ctx.out);
  }
  if (ctx.out.length === 0) return result("approval", "unknown", ["no command found"]);
  let category: BashCategory = "read";
  for (const c of ctx.out) if (SEVERITY[c.category] > SEVERITY[category]) category = c.category;
  const reasons = [...new Set(ctx.out.filter((c) => c.reason).map((c) => c.reason!))];
  let decision: BashDecision = category === "read" || category === "local" ? "allow" : "approval";
  if (context.tainted && category !== "read") {
    decision = "approval";
    reasons.push("untrusted content was read in this run: only read-only commands run without approval");
  }
  return result(decision, category, reasons, ctx.out);
}
