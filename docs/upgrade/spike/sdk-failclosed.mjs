// Spike: does sandbox.enabled fail closed when bubblewrap is missing? Stub token only.
import { query } from "/root/apps/workforce-os-v2/apps/worker/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
const mode = process.argv[2]; // "default" | "degrade"
const sandbox = mode === "degrade" ? { enabled: true, failIfUnavailable: false } : { enabled: true };
const started = Date.now();
const seen = [];
try {
  for await (const m of query({
    prompt: "Run the shell command: echo sandbox-probe",
    options: {
      cwd: process.env.CWD, model: "claude-sonnet-5-5", settingSources: [], permissionMode: "default",
      tools: ["Bash"], sandbox, maxTurns: 2,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CODE_OAUTH_TOKEN: "stub-token-not-real", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      canUseTool: async (name, input) => { seen.push(`canUseTool:${name}`); return { behavior: "deny", message: "spike" }; },
      stderr: (d) => seen.push(`stderr:${d.trim().slice(0, 160)}`),
    },
  })) {
    if (m.type === "result") seen.push(`result:${m.subtype}:${(m.errors ?? [m.result]).join("|").slice(0, 200)}`);
    else if (m.type === "system") seen.push(`system:${m.subtype}`);
    else if (m.type === "assistant") seen.push(`assistant:${m.error ?? "message"}`);
  }
} catch (e) {
  seen.push(`threw:${e.message.slice(0, 200)}`);
}
console.log(JSON.stringify({ mode, ms: Date.now() - started, seen: seen.slice(0, 12) }, null, 1));
