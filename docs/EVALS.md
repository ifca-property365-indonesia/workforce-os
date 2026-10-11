# Evals

Two tiers check how the worker *behaves* end to end, on top of the unit tests:

| Tier | Command | Calls Claude? | In `pnpm test`? |
| --- | --- | --- | --- |
| Scenarios (hermetic) | `pnpm --filter @wfos/worker eval` | no (scripted SDK) | **yes** |
| Live routing | `EVAL_LIVE=1 pnpm --filter @wfos/worker eval:live` | yes (Haiku 5.5) | never |

## Scenario tier

Each file in `apps/worker/test/scenarios/*.json` is one scenario: a small world, a scripted model run per
employee, one or more triggers that call the real entry points, and a list of expectations. The runner
(`apps/worker/test/scenario-runner.ts`) builds the world in the throwaway test database, swaps the Agent SDK for
the scripted mock (`src/runner/mock-sdk.ts`, via `setQueryImpl`), fires the triggers, freezes the evidence, and
scores it. `test/scenarios.test.ts` runs every file as a vitest case (`describe.each`) and prints a compact score
table when one fails (`EVAL_VERBOSE=1` prints it for passing ones too).

**Included in the normal suite, deliberately**: the scenarios use the same throwaway Postgres and mock transports
(Redis, queues, SMTP, embeddings, network blocked) as every other worker test, take about 8 s together (5 s of
it is the routing-timeout scenario waiting for the real 5 s classifier timeout), and guard safety behaviour (approvals,
taint, watchdogs) that should never regress silently. `pnpm eval` is the same files on their own.

Prerequisite: `TEST_DATABASE_ADMIN_URL` in `.env`, as for the other tests (README → Tests).

### Format

```jsonc
{
  "name": "webhook_task_needs_approval",          // snake_case, must equal the file name
  "description": "…",                              // the vitest case title
  "timeoutMs": 20000,                              // optional (default 20 s)
  "runtime": { "idleTimeoutMs": 60 },              // optional: run idle watchdog (setRunIdleTimeoutMs)
  "setup": {
    "workspace": { "guardsEnabled": true },        // optional
    "employees": [{ "key": "sari", "name": "Sari", "role": "Support", "autonomyLevel": "CLOSE",
                    "toolPermissions": [{ "tool": "send_email", "enabled": true }],
                    "allowList": [{ "tool": "send_email", "recipientDomains": ["client.co.id"] }] }],
    "teams":    [{ "key": "ops", "lead": "budi", "members": ["sari"], "responderMode": "auto" }],
    "tasks":    [{ "key": "t1", "assignee": "sari", "status": "QUEUED", "parent": "…", "team": "…",
                   "phase": "wait", "retryCount": 0, "untrustedInput": false, "routine": "…" }],
    "routines": [{ "key": "daily", "assignee": "sari", "overlap": "skip", "dueAgoMs": 60000 }],
    "routineRuns": [{ "routine": "daily", "tasks": ["t1"], "status": "dispatched" }],
    "conversation": { "team": "ops" }               // or { "employee": "sari" }
  },
  "scripts": {
    "sari": [ /* MockStep[] for one run, or MockStep[][] for consecutive runs */ ],
    "$router": [ /* the team-chat routing classifier's run */ ]
  },
  "trigger": { "kind": "task", "task": "t1" },      // or a list, fired in order
  "expect": [{ "scorer": "approvalCreated", "tool": "send_email", "rule": "taint" }]
}
```

- **Keys** name rows inside the scenario; `{{employee.k}}`, `{{task.k}}`, `{{team.k}}`, `{{routine.k}}`,
  `{{conversation.k}}` and `{{workspace}}` in scripts, triggers and expectation arguments resolve to their ids.
  A task can also be referenced by its exact title (for tasks a run created, e.g. with `create_task`).
- **Script steps** are `MockStep`s: `{llm:{input,output,text?,model?}}`, `{tool, input, output?, error?, durationMs?}`,
  `{wait: ms}`, `{result}`, `{event}`, plus `{repeat: n, step: {tool…}}` for loops. Platform tools are
  `mcp__wfos__<name>` (their real handlers run); any other `mcp__<server>__<tool>` is an external MCP tool that
  returns `output`. A run is routed to an employee by the `You are <name>,` line of its system prompt (so
  employee names must be unique); the routing model's run goes to `$router`. A run with no script left replies
  `Reply from <name>` (enough for chat responders), and is visible to the `sdkRuns` scorer.
- **Triggers**: `task` (runTask, optional `resumeNote`), `chat` (a user message via the web's path, then runChat;
  `mentions`, `mentionAll`, `untrusted`), `routine_tick` (tickRoutines), `routine_dispatch` (dispatchRoutine),
  `fail_task` (failTask with `error`, `failKind`), `webhook_task` (createTask exactly as `POST /api/hooks/:id`
  does: `source: "webhook"`, `untrustedInput: true`, then runTask unless `run: false`), `decide_approval`
  (approve → executeApproval, reject → handleRejection; the latest PENDING approval, of `tool` if given).
- A malformed file fails loading with the path of the bad field (zod); unknown scorers, bad scorer arguments,
  duplicate keys and scripts for unknown employees are rejected too.

### Evidence and scorers

After the triggers, the runner reads (and deep-freezes) the workspace's `tasks`, `approvals`, `steps`, `messages`,
`incidents`, `routineRuns`, the sent mail, published events, queued jobs (filtered to the workspace), every
scripted tool call (`who`, tool, input, allow/deny, output or denial message) and every SDK run. Scorers are pure
functions of that evidence returning `{pass, detail}`. Most take `count` (exact) or `min` (default 1).

| Scorer | Arguments | Passes when |
| --- | --- | --- |
| `approvalCreated` | `tool`, `rule?` (taint/leak/autonomy), `status?`, `task?` | matching approvals exist |
| `noApproval` | `tool?` | no approval (of that tool) |
| `mailSent` | `to?` | mail went out (to that address) |
| `noMailSent` | — | nothing was sent |
| `taskStatus` | `task`, `status` | the task has that status |
| `taskTainted` | `task`, `expected?` (default true) | `untrustedInput` equals `expected` |
| `taskMatches` | `task`, `fields` | partial match on the task row |
| `taskCount` | `count`, `routine?`, `source?` | the workspace has that many tasks |
| `stepRecorded` / `noStep` | `name`, `status?`, `kind?`, `task?` | a step of that name exists / does not |
| `incidentOpened` | `kind`, `status?`, `task?` | matching incidents exist |
| `messageReplies` | `count?`, `employee?`, `routedBy?` (partial), `untrusted?` | assistant replies match |
| `toolCall` | `tool`, `permission?`, `output?` (regex), `employee?` | the scripted model made that call |
| `routineRun` | `routine`, `status` | matching routine runs exist |
| `eventPublished` | `type` | a pub/sub event of that type was published |
| `jobQueued` | `queue`, `name?`, `kind?` (data.kind), `task?` | matching jobs were queued |
| `sdkRuns` | `who` (employee key or `$router`) | that many SDK queries were made for it |

`rule` is derived from the approval's stored reason (approvals do not store the gate rule): the exact taint and
leak reasons of `applyRunSignals`, else `autonomy` for the gate's "Irreversible action …" reasons.

### Scenarios

| File | Checks |
| --- | --- |
| `send_email_queue_needs_approval` | QUEUE autonomy: send_email → PENDING approval (autonomy), no mail, AWAITING_APPROVAL, one notify |
| `approved_send_executes` | …then approved: executed once, mail sent, task DONE |
| `taint_from_mcp_forces_approval` | injected external MCP result → input_guard step, allow-listed CLOSE send needs approval (taint), task untrusted |
| `allowlisted_close_send_unattended` | the same send on a clean run: mail sent, no approval, DONE, trusted |
| `team_auto_routing_timeout_fallback` | auto team chat, classifier times out → the lead answers with routedBy fallback/timeout |
| `incident_retry_limit_refused` | a subtask with both retries used fails → escalated incident; the lead's third retry is refused |
| `repeat_detector_stops_loop` | identical allow-listed calls: allowed twice, denied from the 3rd, stopped on the 5th; loop incident |
| `watchdog_stops_idle_run` | a silent run is stopped as stalled; stalled incident |
| `routine_overlap_skip` | previous firing still open → skipped_overlap, nothing dispatched |
| `webhook_task_needs_approval` | webhook-created task starts tainted: untrusted_input step, allow-listed send needs approval |
| `create_task_from_tainted_run` | create_task from a tainted run yields an untrusted follow-up whose send needs approval |

### Adding a scenario

1. Copy the closest file in `apps/worker/test/scenarios/`, rename it, and set `name` to the new file name.
2. Describe the world in `setup`, script each employee's run(s), pick the trigger(s).
3. Write the expectations as evidence checks, not implementation details. Make at least one expectation
   fail on the bug you are guarding against (flip it once locally to see the score table).
4. `pnpm --filter @wfos/worker eval` (add `EVAL_VERBOSE=1` to see every table). A new scorer goes into
   `SCORERS` in `scenario-runner.ts` with a zod argument schema, and into the table above.

## Live tier

`apps/worker/evals/routing.live.test.ts` runs the real team-chat route classifier (`classifyResponder` in
`src/runner/route-classifier.ts`, model `ROUTING_MODEL` = Claude Haiku 5.5) on the 40 labelled messages in
`evals/routing.labels.json` (Indonesian and English; team: Lead PM, Developer, Finance, Marketing; some messages
accept two answers, team-wide announcements accept `everyone` or the lead, one carries a prompt injection).

```bash
cd apps/worker
EVAL_LIVE=1 CLAUDE_CODE_OAUTH_TOKEN=… pnpm eval:live                        # subscription token
EVAL_LIVE=1 CLAUDE_AUTH_MODE=api_key ANTHROPIC_API_KEY=… pnpm eval:live    # API key
```

- Skipped (and no database is created) unless `EVAL_LIVE=1` and a real credential is in the shell environment.
  It has its own config (`evals/vitest.config.ts`) without `test/setup.ts`, which would replace the credential with
  a stub; it still uses a throwaway database and mocked Redis/SMTP. The default config only includes `test/**`, so
  `pnpm test` never runs it.
- Reports, per message, the expected and chosen member, confidence and latency; then **accuracy** (the
  classifier's own pick matches a label; a fallback counts as wrong), **effective accuracy** (who answers in
  production, where a fallback goes to the lead), **fallback rate** by reason (timeout / invalid / low_confidence /
  error), p50 latency and the cost summed from the `route_decision` steps.
- Fails when accuracy is below `EVAL_MIN_ACCURACY` (default `0.75`). `EVAL_CONCURRENCY` (default 4) sets parallel calls.
  Each call starts a Claude Code process and has the production 5 s timeout, so a slow host shows up as timeouts.
- **Cost**: about 400 input and 20 output tokens per message at Haiku 5.5 prices (0.01 / 0.05 credits per 1K,
  1 credit = $0.01): roughly **$0.0001 per message, under $0.005 per full run**. With a subscription token it
  counts against the plan's usage instead.
