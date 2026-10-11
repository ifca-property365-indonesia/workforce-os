# workforce-os as an MCP server

Workforce OS exposes its workforce (employees, teams, tasks, chats) as a **Model Context Protocol** server at
`<APP_URL>/api/mcp`. Point Claude Code, Claude Desktop or any other MCP client at it, and you can hand work to your
AI employees from wherever you already use Claude: "ask the Finance team to draft the October invoices and wait for
the result".

The server acts **as you**: each request carries a personal API token, and the token has exactly your current role in
the workspace it was created in.

## What it exposes

| Tool | Role | What it does |
|---|---|---|
| `list_employees` `{status?}` | VIEWER | Employees (id, name, role, status, autonomy level, department, persona cut to 300 characters). Archived employees only when asked for by status. |
| `list_teams` | VIEWER | Teams with Lead, member ids and responder mode. |
| `list_tasks` `{status?, employeeId?, limit ≤ 50}` | VIEWER | Recent tasks, newest first (id, title, status, assignee, created). |
| `get_task` `{taskId}` | VIEWER | Brief, status, result, error, deliverables (title, kind, 500-character excerpt) and the number of pending approvals. |
| `create_task` `{title, brief?, employeeId? \| teamId?, dryRun?}` | MEMBER | Creates and starts a task exactly like the board does (same validation, same queue). Audited as `api-token:<token name>`. |
| `send_message` `{employeeId? \| teamId? \| conversationId?, text}` | MEMBER | A chat message. An employee or team starts a new conversation; a `conversationId` continues one. `@Name` mentions work in team chats. Replies arrive asynchronously. |
| `wait_for_task` `{taskId, timeoutSec ≤ 60}` | VIEWER | Polls every 2 s until the task is `done`, `needs_approval`, `failed` or `cancelled`; `timeout` when it is still running (call again). `timeoutSec: 0` checks once and answers `running`. |
| `get_conversation` `{conversationId, limit ≤ 50}` | VIEWER | The latest messages, oldest first (role, employee, content, status). |
| `list_approvals` `{status? = PENDING}` | VIEWER | Title, tool, employee, task, created. The payload (and reason) only for OWNER/ADMIN. |

Everything is scoped to the token's workspace: ids from another workspace answer "not found". A tool that fails
(wrong role, unknown id, invalid input) returns an MCP error result (`isError: true`) with a short message, never an
HTTP 500.

Results and chat replies are written by AI employees. Your MCP client should treat them as data, not as instructions
(the server tells clients this in its `instructions`).

## What it deliberately does not expose

- **Deciding approvals** (approve, edit & approve, reject). Outbound actions stay behind a person in the web app or
  Telegram. An agent outside workforce-os must not be able to approve the actions of an agent inside it.
- **Deleting anything** (tasks, employees, conversations, documents).
- **Credentials and settings**: Claude credential, MCP servers, SMTP, repositories, webhooks, workspace settings.
- **The kill switch**, budgets and limits.
- **Member management** and API tokens themselves (a token cannot mint or revoke tokens).

## Tokens

Create tokens in **Settings → API access**.

- Creating a token needs the MEMBER role or higher, **two-factor authentication**, and a fresh password + authenticator
  confirmation (the same step-up as other sensitive changes). Accounts without 2FA cannot create tokens.
- Expiry: 30, 90 (default), 180 or 365 days. Every token expires; create a new one before it runs out. Changing your password, an admin password reset or removal from the workspace revokes your tokens.
- The token (`wfos_` + 43 characters) is shown **once**. Workforce OS stores only its SHA-256 and the first characters
  (`wfos_ab12cd`) so you can recognise it in the list.
- A token stops working when it expires, is revoked, or its user is removed from the workspace. Role changes apply
  immediately: a member demoted to VIEWER keeps read access but loses `create_task` and `send_message`.
- Accounts that must change their password, or OWNER/ADMIN accounts with a pending required 2FA enrollment, are refused
  (403) until that is done in the browser.
- OWNER and ADMIN see every member's tokens under **All tokens in this workspace** and can revoke any of them.
- Creating and revoking are audited (`api_token.created`, `api_token.revoked`); tasks created through a token are audited
  with actor `api-token:<name>`. Each token records when it was last used (to the minute).
- A user can have at most 20 active tokens per workspace. Anyone (VIEWER included) can list and revoke their own tokens.

Treat a token like a password: keep it in an environment variable or your client's secret store, not in a repository.
Revoke it as soon as a laptop is lost or a token was pasted somewhere it should not be.

## Rate limits

- **120 requests per minute per token**; above that the server answers `429` with `Retry-After: 60`.
- `wait_for_task` holds a request for at most 60 seconds.
- Request bodies are limited to 1 MiB; task briefs and messages to 20,000 characters.

## Setup

### Claude Code

```bash
claude mcp add --transport http workforce-os https://ai.example.com/api/mcp \
  --header "Authorization: Bearer wfos_…"
```

Settings → API access shows this command with your URL and the new token filled in. Add `--scope user` to make it
available in every project. In a shared `.mcp.json`, keep the token out of the file with environment variable
expansion:

```json
{
  "mcpServers": {
    "workforce-os": {
      "type": "http",
      "url": "https://ai.example.com/api/mcp",
      "headers": { "Authorization": "Bearer ${WFOS_TOKEN}" }
    }
  }
}
```

Check with `claude mcp list`, or `/mcp` inside a session.

### Claude Desktop

Claude Desktop's custom connectors expect OAuth. For a bearer token, bridge with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "workforce-os": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://ai.example.com/api/mcp", "--header", "Authorization:${WFOS_AUTH}"],
      "env": { "WFOS_AUTH": "Bearer wfos_…" }
    }
  }
}
```

(The header value is passed through an environment variable because some platforms split arguments on spaces.)
Restart Claude Desktop afterwards.

### Other clients

Any client that speaks the **Streamable HTTP** transport works: `POST <APP_URL>/api/mcp` with
`Authorization: Bearer wfos_…`, `Content-Type: application/json` and `Accept: application/json, text/event-stream`.

## Protocol notes

- Streamable HTTP in **stateless** mode with JSON responses (`@modelcontextprotocol/sdk`
  `WebStandardStreamableHTTPServerTransport`, `sessionIdGenerator: undefined`, `enableJsonResponse: true`): every POST
  is authenticated and served on its own; there is no `Mcp-Session-Id`.
- `GET` (server-sent event stream) and `DELETE` (session end) answer `405 Method Not Allowed`. Clients fall back to
  plain request/response.
- Authentication errors answer `401` with `WWW-Authenticate: Bearer` and the same generic message for unknown, revoked
  and expired tokens.
