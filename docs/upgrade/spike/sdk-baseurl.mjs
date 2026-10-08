import { query } from "/root/apps/workforce-os-v2/apps/worker/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
const [kind, port] = process.argv.slice(2);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
if (kind === "oauth") env.CLAUDE_CODE_OAUTH_TOKEN = "dummy-oauth-xyz"; else env.ANTHROPIC_API_KEY = "dummy-apikey-xyz";
try { for await (const m of query({ prompt: "hi", options: { cwd: process.env.CWD, model: "claude-sonnet-5-5", settingSources: [], tools: [], maxTurns: 1, env } })) if (m.type === "result") console.log("result", m.subtype); } catch (e) { console.log("threw", e.message.slice(0, 100)); }
