# Claude Code Analytics Proxy - Design Spec

## Summary

Implement a Hold & Gate analytics pipeline in codemie-code, exposed as `codemie proxy connect --claude-code --analytics`. Claude Code hook invocations and its native OTel SDK export must never block on network I/O (Claude Code enforces hook timeouts), so all incoming analytics data is spooled to disk immediately and forwarded to the CodeMie analytics backend by a separate periodic background process - never synchronously from the hook/export path.

This is a new, independent pipeline targeting an independently-run, external Claude Code CLI/Desktop session. It does not modify or interact with the existing `claude`/`claude-acp` agent plugin (CodeMie's own managed Claude Code launcher) - this feature is analytics-only.

## Goals

- `codemie proxy connect --claude-code --analytics` wires an external Claude Code session's native hooks and native OTel SDK export to the shared CodeMie proxy daemon.
- No analytics data is silently dropped on transient forwarding failure - it stays on disk until it can be sent.
- Forwarding is gated on completeness (Hold & Gate logic) so partial session data is not force-sent prematurely, while still guaranteeing eventual delivery.
- Reuses existing codemie-code infrastructure (shared daemon, agent registry, `codemie hook` dispatch, `CODEMIE_ENDPOINTS`) rather than introducing a second daemon or duplicating CLI plumbing.

## Non-goals

- No changes to the existing `claude`/`claude-acp` agent's launch, settings, or plugin-installation logic.
- No test-writing.
- No git commits - all changes are left unstaged per explicit user instruction.

## Architecture Overview

Two independent delivery paths:

- **Path A (native OTLP export)**: Claude Code's built-in OTel SDK exports logs/metrics/traces as OTLP/protobuf directly over HTTP, when `CLAUDE_CODE_ENABLE_TELEMETRY=1` and `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_PROTOCOL` point at the local daemon.
- **Path B (hooks)**: Claude Code's native hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`) invoke `codemie hook --agent claude-code --analytics`, which does a fast, error-swallowing POST of the raw hook JSON to the daemon and returns immediately.

Both paths write to a **per-session disk spool** inside the daemon process. A **periodic background tick**, running at a fixed interval for the daemon's lifetime (not per-request), reads the spool, decides per session whether it is safe to forward (completeness gating), and POSTs to the analytics backend using the daemon's existing stored SSO credentials. The daemon is the existing shared proxy daemon managed by `daemon-manager.ts` / `connect-orchestrator.ts` - no second daemon process.

```
Claude Code (external process)
  ├─ native OTel SDK ──HTTP/protobuf──> daemon: POST /v1/analytics/claude-code/otlp/{logs,metrics,traces}
  └─ native hooks ──codemie hook──────> daemon: POST /v1/analytics/claude-code/hooks
                                              │
                                       disk spool (per session)
                                              │
                                   periodic tick (onProxyStart timer)
                                              │
                                   completeness gate (Case A/B/C)
                                              │
                              analytics backend: /event-hooks, /logs, /metrics, /traces
```

## Components

### 1. No new agent registry entry

No new agent plugin is added. The agent is `claude-code` (the existing registry entry). The `--analytics` flag on `codemie hook` is the sole signal that a hook invocation belongs to the analytics pipeline - not agent metadata. The daemon-side ingest plugin validates `agentName` against `AgentRegistry.getAgentNames()` as a basic sanity check; `claude-code` already passes this check.

### 2. `hook.ts` change: `--analytics` ingestion-mode bypass

`createHookCommand()` already accepts `--analytics` as a boolean option. When set, the hook is routed directly to the disk-spool path, bypassing the shared transform/validate/route pipeline entirely - the same early-exit pattern used by `agentOtlpIngestion`:

```ts
if (agentOtlpIngestion(agentName)) {
  await forwardOtlpEvent(rawInput, agentName);
  writeAgentStdoutResponse(agentName, event.hook_event_name);
  await logger.close();
  process.exitCode = 0;
  return;
}
if (opts.analytics) {
  await forwardHookEventToSpool(rawInput, agentName);
  await logger.close();
  process.exitCode = 0;
  return;
}
// existing pipeline
```

No agent name remapping occurs - `agentName` remains `'claude-code'` throughout. The `opts.analytics` flag is the sole dispatch signal.

Note: `forwardOtlpEvent` is not defined in `hook.ts` - it is imported from `src/agents/plugins/cursor-ide/cursor-ide.otlp-forwarder.ts`. The new `forwardHookEventToSpool` follows the same pattern: defined in its own file and imported into `hook.ts`.

### 3. `forwardHookEventToSpool()` (new file: `src/agents/plugins/claude/claude-code-analytics.hook-forwarder.ts`)

Called from the hook process side. Must be fast, non-blocking, and error-swallowing:

- Call `readState()` + `isProcessAlive(pid)` from `daemon-manager.ts`. If no live daemon is found, log at debug level and return immediately. Spooling requires the daemon to be running; if it is not, `codemie proxy connect --claude-code --analytics` has not been run.
- POST `{ agentName, timestamp, raw: rawInput }` to `${state.url}/v1/analytics/claude-code/hooks` with `Authorization: Bearer ${state.gatewayKey}`. `raw` is Claude Code's native, untransformed hook JSON exactly as received on stdin - no field-mapping or enrichment here.
- Swallow all errors. Never throw. Never affect the hook's exit code.

This function performs no disk I/O itself - disk writing happens entirely on the daemon side in the ingest plugin (component 4). Event-shape transformation is deferred to the backend forwarder (component 6), which runs at tick time in the daemon using daemon-side resolution helpers.

### 4. New proxy plugin: `claude-analytics-ingest.plugin.ts`

New file under `src/providers/plugins/sso/proxy/plugins/`, registered in `plugins/index.ts` at the same priority band as `OtlpIngestPlugin` (priority 10). Implements `ProxyPlugin` + a `ProxyInterceptor` with `handleRequest` that intercepts and handles the following routes without forwarding them upstream:

**`POST /v1/analytics/claude-code/hooks`** - Path B ingest:

- Require `ctx.metadata.gatewayKeyValidated` (respond 401 otherwise).
- Parse `{ agentName, timestamp, raw }` from `ctx.requestBody` (JSON). Validate `agentName` against `AgentRegistry.getAgentNames()` (respond 400 if not recognized).
- Extract `session_id` from the parsed `raw` hook JSON. Claude Code hooks always include `session_id` at the top level - no binary scan needed.
- Inside `withSessionLock(sessionId, ...)`, append `raw` as one NDJSON line to `<sessionId>.hooks.ndjson` under the spool directory, and touch `<sessionId>.status`.
- Respond `202 { accepted: true }` immediately after the disk append resolves. No forwarding attempted here.

**`POST /v1/analytics/claude-code/otlp/logs`**, **`/otlp/metrics`**, **`/otlp/traces`** - Path A ingest (one route per signal kind):

- Same gateway-key check.
- Body is raw OTLP protobuf bytes (`ctx.requestBody: Buffer` - byte integrity is preserved through the proxy layer; no JSON parsing).
- Extract session ID by scanning a latin1 string view of the buffer for a UUID v4 pattern. OTLP/protobuf stores strings as raw UTF-8 bytes inside length-delimited fields, which are readable as latin1 without a full decode:

```ts
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function extractSessionIdFromProtobuf(buf: Buffer): string | null {
  // UUIDs are stored as plain UTF-8 strings inside protobuf length-delimited
  // fields. A latin1 view of the binary payload contains the raw bytes, so a
  // regex scan finds the UUID without a full protobuf decode.
  // Known limitation: the scan matches the first UUID-shaped value in the
  // buffer. If the payload contains multiple UUIDs (e.g. trace IDs, span IDs)
  // before session_id, it may return the wrong value. In practice Claude Code
  // places session_id early in resource attributes, so false positives are
  // rare - but not impossible on atypical payloads.
  const m = buf.toString("latin1").match(UUID_RE);
  return m ? m[0] : null;
}
```

- Inside `withSessionLock`, append raw bytes to `<sessionId>.otel_logs.bin`, `<sessionId>.otel_metrics.bin`, or `<sessionId>.otel_traces.bin` respectively, and touch `<sessionId>.status`.
- Respond `200` immediately.
- If no session ID can be extracted (malformed protobuf), append the bytes to `_unresolved.alert` instead of dropping them.

### 5. Disk-spool + completeness-gating module (new dir: `src/providers/plugins/sso/proxy/plugins/claude-analytics-spool/`)

Split into focused files:

**`spool-paths.ts`** - per-session file path helpers. Spool root is `getCodemiePath('proxy', 'claude-analytics-spool')`. Per-session files:

- `<sessionId>.hooks.ndjson`
- `<sessionId>.otel_logs.bin`
- `<sessionId>.otel_metrics.bin`
- `<sessionId>.otel_traces.bin`
- `<sessionId>.status` - JSON tracking which groups have been touched and forwarding cursors.

**`session-lock.ts`** - `withSessionLock(sessionId, fn)`: per-session async mutex implemented via `Map<string, Promise>` chaining. Guarantees that ingest-append and tick-processing for the same session never interleave, while different sessions are processed fully in parallel.

> **Known gap:** the same lock is held by both the ingest path (fast - a single disk append) and the tick processor (slow - may include multiple HTTP round-trips to the backend on retry). A slow or hung backend will delay hook-event ingest appends for the same session for the full tick duration. Claude Code's hook timeout may expire before the lock releases, causing that hook event to be lost. A future improvement is to use separate producer/consumer primitives (e.g. a try-lock on the tick side that skips sessions currently being ingested, or a dedicated append queue). Acceptable for the initial implementation.

**`completeness-gate.ts`** - the Hold & Gate decision logic:

- `HOOKS` group = `{hooks}`; `OTEL` group = `{otel_logs, otel_metrics, otel_traces}`. A group is considered "touched" once any of its data-kind files has data recorded in `<sessionId>.status`.
- **Case A** (both groups touched): safe to forward - send everything pending, no alert.
- **Case B** (exactly one group touched): ambiguous - wait `MAX_ATTEMPTS` ticks before finalizing. `MAX_ATTEMPTS` defaults to 4, overridable via `CODEMIE_CLAUDE_ANALYTICS_MAX_ATTEMPTS`. On finalize: force-send if `ALLOW_HOOKS_ONLY_FORWARD` (true by default) is enabled (hooks-only case); OTel-only sessions are never force-sent. Raise a deduped alert entry in the daemon log (not surfaced to the user's terminal).
- **Case C** (neither group touched): no-op.

**`tick-processor.ts`** - `processSessionTick(sessionId)`: applies the Case A/B/C decision, calls the backend forwarder (component 6) for sessions cleared to send, and updates `<sessionId>.status` accordingly.

**`ttl-sweep.ts`** - a separate periodic sweep that deletes fully-resolved, non-alerted `.status` files and their associated empty spool files after `STATUS_TTL_MINUTES` of inactivity (default 60). The sweep must acquire `withSessionLock(sessionId, ...)` before reading status and deleting files, so it never races with a concurrent ingest append or tick processing pass for the same session.

### 6. Backend forwarder (new file: `src/providers/plugins/sso/proxy/plugins/claude-analytics-spool/forwarder.ts`)

Runs at tick time. Uses the daemon's stored SSO/JWT credentials via `buildAuthHeaders()` from `src/providers/core/codemie-auth-helpers.ts` to authenticate outbound requests.

**OTLP bytes (Path A):** POST the raw protobuf buffer verbatim to `CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS`, `CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS`, or `CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES` (fields of the `CODEMIE_ENDPOINTS` object in `sso.http-client.ts`). The analytics backend forwards the raw body to the internal OTLP collector unchanged - true byte-for-byte passthrough.

**Auth coverage:** `buildAuthHeaders()` from `src/providers/core/codemie-auth-helpers.ts` is used to build request headers. Only the SSO credentials case (`isSSOCredentials(credentials)`) is supported - JWT-auth daemon deployments are not covered and will produce malformed headers. This is a known limitation acceptable for the initial implementation.

**Hook NDJSON (Path B):** Requires a mapping/enrichment step before POST - not a passthrough. The analytics backend's `/event-hooks` route parses each NDJSON line, builds an OTLP LogRecord from `event["type"]` (used for both the event-type label and severity lookup - an unmapped `type` silently degrades severity), and reads from a fixed 23-key attribute whitelist:

```
session_id, prompt_id, agent_id, agent_type, codemie_project_name, cwd, denial_reason,
developer_name, effort, error_message, error_type, git_branch, notification_type,
permission_mode, prompt_body, reason, repo_remote, skill_name, source, tool_input,
tool_name, tool_output, tool_use_id, trigger
```

For each raw spooled line, parse Claude Code's native hook JSON and build a new event object:

**Hook name to `agent.*` type mapping:**

| Claude Code native `hook_event_name` | Mapped `type`           |
| ------------------------------------ | ----------------------- |
| `SessionStart`                       | `agent.session.start`   |
| `UserPromptSubmit`                   | `agent.prompt.submit`   |
| `PreToolUse` (not denied)            | `agent.tool.start`      |
| `PreToolUse` (denied)                | `agent.tool.denied`     |
| `PostToolUse` (success)              | `agent.tool.end`        |
| `PostToolUse` (error)                | `agent.tool.error`      |
| `Stop`                               | `agent.session.stop`    |
| `SessionEnd`                         | `agent.session.end`     |
| `SubagentStop`                       | `agent.subagent.stop`   |
| `PreCompact`                         | `agent.session.compact` |
| `Notification`                       | `agent.notification`    |

**Fields to resolve at tick time (not passthrough):**

- `developer_name` and `user.email`: decode the active SSO/JWT token to extract the user's email. `resolveUserEmail` in `otlp-dispatcher.ts` is a private class method and cannot be imported - duplicate the JWT-decode logic inline in the forwarder.
- `git_branch` and `repo_remote`: call `detectGitBranch()` and `detectGitRemoteRepo()` from `src/utils/processes.ts` using `cwd` already present in the raw hook JSON. Cache per session per tick (keyed on the session's `cwd`) to avoid repeated `git` shell-outs for multi-event sessions.
- `codemie_project_name`: read from the connector's configured project name stored in daemon state. Verify during implementation that `DaemonState` (from `daemon-manager.ts`) carries this field; if not, it must be added to the state schema when the daemon is spawned for this connector.

**Passthrough fields** (read directly from Claude Code's native hook JSON under the same key names):
`session_id`, `prompt_id`, `tool_name`, `tool_use_id`, `tool_input`, `tool_output`, `permission_mode`, `error_message`, `reason`, `trigger`, `notification_type`, `denial_reason`, `effort`, `agent_id`, `agent_type`, `prompt_body`, `source`, `skill_name`.

Re-serialize the mapped events as NDJSON and POST to `${baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}` (`/v1/analytics/cli-analytics/event-hooks`). This constant already exists in `sso.http-client.ts` with no caller today - this is its first use.

**Retry and error behavior:**

- On 401/403: attempt one forced credential-refresh (reusing the daemon's existing SSO refresh mechanism), then mark the session's status as `auth-expired` and leave data on disk. Never delete on auth failure.
- On any other failure: leave data on disk, retry next tick indefinitely. Nothing is deleted from the spool until a forward attempt returns success.
- Mapping/enrichment is re-derived from the still-raw spooled JSON on every retry - nothing transformed is persisted to disk, so a crash mid-tick loses no information.
- On success: truncate/clear the forwarded portion of the spool file(s) and advance the per-kind cursor in `<sessionId>.status`.

### 7. Periodic tick lifecycle

The ingest plugin's `ProxyInterceptor` implements `onProxyStart` / `onProxyStop`, following the same pattern as `SSOSessionSyncInterceptor` in `sso.session-sync.plugin.ts`:

- `onProxyStart()`: run one eager tick pass immediately (crash recovery - spool files on disk are the authoritative state, so a fresh daemon start must process anything left over from a prior run). Then start `setInterval(() => tick(), SEND_INTERVAL_MS)` with `SEND_INTERVAL_MS` defaulting to 5000ms, overridable via `CODEMIE_CLAUDE_ANALYTICS_SEND_INTERVAL_MS`. Also start the slower TTL-sweep interval.
- `onProxyStop()`: clear both intervals, then run one final tick pass as a best-effort flush on graceful shutdown.

Forwarding is driven only by these fixed intervals - never triggered by a specific hook event or inbound request.

### 8. `CAN_SEND` gate

Forwarding for a session is permitted only once the OTEL group has been touched at least once (Case A or Case B state in the completeness gate) or `MAX_ATTEMPTS` has forced a hooks-only finalize. This is not an independent mechanism - it is the completeness gate's own Case A/B/C logic from component 5.

The connector (component 9) makes Case A the common path in practice: it sets `CLAUDE_CODE_ENABLE_TELEMETRY=1` in `.claude/settings.json` so Path A is normally active for any session started after `--claude-code --analytics` is run. If the OTel SDK is disabled or misconfigured, sessions fall into Case B (hooks-only) and are handled as described in component 5.

### 9. Connector: `src/providers/plugins/sso/proxy/connectors/claude-code-analytics.ts`

Responsibilities:

- Before writing settings, call `readState()` from `daemon-manager.ts` to read the already-running daemon's actual `gatewayKey`. Never hard-code or assume the default value. `connect-orchestrator.ts` guarantees the daemon is already up before connectors run.
- Atomically merge into **project-local** `<projectRoot>/.claude/settings.json`. Resolve `projectRoot` via the shared `resolveProjectRoot()` helper. This means `codemie proxy connect --claude-code --analytics` must be run from (or resolve to) the project directory the user intends to work in, and Claude Code sessions must be started from that same project for the merged settings to take effect.

Settings written:

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "codemie hook --agent claude-code --analytics",
      },
    ],
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "codemie hook --agent claude-code --analytics",
      },
    ],
    "PreToolUse": [
      {
        "type": "command",
        "command": "codemie hook --agent claude-code --analytics",
      },
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "codemie hook --agent claude-code --analytics",
      },
    ],
    "Stop": [
      {
        "type": "command",
        "command": "codemie hook --agent claude-code --analytics",
      },
    ],
    "SubagentStop": [
      {
        "type": "command",
        "command": "codemie hook --agent claude-code --analytics",
      },
    ],
    "PreCompact": [
      {
        "type": "command",
        "command": "codemie hook --agent claude-code --analytics",
      },
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "codemie hook --agent claude-code --analytics",
      },
    ],
  },
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "<daemonBaseUrl>/v1/analytics/claude-code/otlp",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer <gatewayKey>",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_TRACES_EXPORTER": "otlp",
  },
}
```

Notes on specific fields:

- `OTEL_EXPORTER_OTLP_HEADERS`: **required**. `GatewayKeyPlugin` (priority 7) rejects any request without `Authorization: Bearer <gatewayKey>`. Claude Code's native OTel SDK is not code this feature controls - it only sends headers declared via this env var. Without it, every native OTLP export 401s and Path A never delivers data, forcing every session into Case B.
- `OTEL_EXPORTER_OTLP_HEADERS` format: `key=value[,key=value...]` per the OTel spec - no URL-encoding of the space in the Bearer value.
- `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`: enables additional distributed trace spans; org-allowlist-gated on Anthropic's side. Harmless no-op on non-allowlisted orgs. Set unconditionally.

Additional responsibilities:

- Use the conflict-detection utility from `src/utils/settings-conflict.ts` before writing. (This utility is moved from `src/agents/plugins/claude/settings-conflict.ts` to `src/utils/` to make it importable from the provider layer.) The `claude` agent may also write to the same file when CodeMie launches a managed Claude Code session; this connector must not silently clobber unrelated keys. Surface any conflict exactly as the utility does elsewhere - no new conflict-resolution UI.
- Provide symmetrical teardown: `proxy disconnect --claude-code` removes only the entries this connector added, leaving all other settings untouched. The teardown mechanism mirrors the pattern used by other connectors in this codebase:
  - A **stable string marker** embedded in each written hook command value (e.g. `"codemie hook --agent claude-code --analytics"`) identifies own entries at disconnect time - no separate manifest file is needed, and the marker survives binary path changes.
  - On the **first write to a pre-existing file**, take a backup (e.g. `settings.json.codemie-backup`). Never overwrite an existing backup, since that would enshrine CodeMie's own entries as the original.
  - On **disconnect**: scan all hook arrays for entries matching the marker, filter them out, then: if the resulting file would be empty and a backup exists - restore the backup; if empty and no backup - delete the file; otherwise rewrite the stripped object.
  - All file writes use an **atomic temp-file rename** (write to `<path>.<pid>.tmp`, preserve original permissions, then rename over target) to avoid partial writes.
  - Resolve the target path via `resolveProjectRoot()` (`.git`-walk) for stable path resolution regardless of which directory the disconnect command runs from.

**Gateway-key stability:** `spawnDaemon()` defaults to `'codemie-proxy'` only when no `gatewayKey` is passed at spawn time and does not rotate on restarts unless called with a different value. Baking the key into `settings.json` at connect-time is safe for a running daemon. It goes stale only if the daemon is stopped and respawned with a different `--gateway-key`, in which case re-running `codemie proxy connect --claude-code --analytics` refreshes `settings.json`.

### 10. CLI / orchestrator wiring

**`src/cli/commands/proxy/index.ts`:** Add `--claude-code` boolean option to both `connect` and `disconnect` commands.

**`src/cli/commands/proxy/connect-orchestrator.ts`:**

- Add `claudeCode?: boolean` to `ConnectTargets`.
- Add `'claude-code'` to `EffectiveClientType`.
- Add a case for `'claude-code'` in `deriveDaemonIdentity()`.
- Add an entry in `TARGET_LIST` and `describeTargets()` - both are file-private, so these are in-place edits, not new exports.
- Add a `runClaudeCode()` runner function that calls the new connector.
- Enforce the gating rule: `--claude-code` requires `--analytics`, enforced in `connectTargets()` using the same validation pattern as existing target flags.

**`src/cli/commands/proxy/disconnect-orchestrator.ts`:**

- Add a `disconnectClaudeCode()` function that calls the connector's remove function (mirroring the existing `disconnectCursorIde()` pattern) and prints the appropriate result message.
- Add a `claudeCode?: boolean` check in `disconnectTargets()` to call it.

## Data Flow (happy path)

1. User runs `codemie proxy connect --claude-code --analytics`. Orchestrator ensures the shared daemon is running (spawning it if needed, with the new ingest plugin registered), then calls the connector to merge Claude Code's `settings.json`.
2. User starts a native Claude Code session in the project directory. On `SessionStart`, the hook fires `codemie hook --agent claude-code --analytics`, which calls `forwardHookEventToSpool()` - a fast fire-and-forget POST to the daemon; the hook process exits immediately after.
3. The daemon's ingest plugin appends the raw JSON line to `<sessionId>.hooks.ndjson`, touches `<sessionId>.status`, responds 202. Total added latency to the hook process: one local HTTP round-trip plus a disk append.
4. Claude Code's native OTel SDK independently exports logs/metrics/traces as OTLP/protobuf to the daemon's `/v1/analytics/claude-code/otlp/*` routes; each append is fast and non-blocking from Claude Code's perspective.
5. Every `SEND_INTERVAL_MS`, the tick processes each touched session. Once both HOOKS and OTEL groups are touched (Case A), the forwarder maps/enriches each spooled raw hook JSON line into the `agent.*`-typed backend shape and POSTs the result to `/event-hooks`; OTLP bytes are POSTed verbatim to `/logs`/`/metrics`/`/traces`. Forwarded data is cleared from the spool.
6. On `codemie proxy disconnect --claude-code`, the connector removes its `settings.json` additions. The daemon keeps running if other features still need it, per existing `connect-orchestrator.ts` shutdown rules.

## Error Handling

- **Hook-side POST failure** (daemon down, network error, timeout): swallowed in `forwardHookEventToSpool()`, logged at debug only. Data for that specific hook event is lost (no local retry buffer on the Claude Code process side; the daemon must be running for spooling to happen at all).
- **Ingest-plugin disk write failure** (disk full, permissions): logged as an error at daemon level; the plugin still responds 202/200 to avoid confusing the hook process. This is an operational alert condition, not a data-flow decision.
- **Forward-to-backend failure** (network, 5xx, timeout): data stays on disk, retried next tick indefinitely. No data loss.
- **Auth failure (401/403)**: one forced credential-refresh attempt, then `auth-expired` status marker; data stays on disk pending manual re-auth via `codemie proxy connect` re-run.
- **Unresolvable session ID** (malformed hook JSON, protobuf without a scannable UUID): recorded to `_unresolved.alert` rather than dropped.
- **Native OTLP export rejected by `GatewayKeyPlugin` (401)**: only possible if `settings.json`'s `OTEL_EXPORTER_OTLP_HEADERS` is missing or stale. Claude Code's OTel SDK handles this on its own terms; Path A simply never delivers data for that session - it falls into Case B (hooks-only) and is handled by `MAX_ATTEMPTS`/`ALLOW_HOOKS_ONLY_FORWARD` logic.
- **Ambiguous completeness (Case B) exceeding `MAX_ATTEMPTS`**: force-send per `ALLOW_HOOKS_ONLY_FORWARD` (hooks only; OTel-only is never force-sent) plus a deduped alert log entry - no data loss, but a visible daemon-log signal that one delivery path never showed up for that session.

## Testing

Per repo policy, no tests are written or run unless explicitly requested. If requested later, `withSessionLock`, the completeness-gate Case A/B/C decision table, and the forwarder's retry/auth-failure handling are the highest-value units to cover.

## Rollout / Compatibility Notes

All new code is additive: a new proxy plugin, a new spool module, a new connector, and new CLI flags. The only change to existing code is the small, backward-compatible addition of the `opts.analytics` branch in `hook.ts`'s ingestion-mode dispatch. Existing `otlpIngestion` behavior is preserved verbatim.
