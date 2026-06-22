# RFC: Amp background task driver plugin

- Status: Draft
- Date: 2026-06-04
- Target implementation: Amp project plugin in `.amp/plugins/`, backed by tmux control mode as an
  implementation detail. Shared parser/snapshot pieces can move into core if they become generally
  useful.

## Summary

Build an Amp plugin that gives the model one high-level `background_task` tool for starting,
driving, inspecting, waiting on, and stopping interactive background tasks. The first backend uses a
long-lived tmux control-mode client for live output and input, and tmux `capture-pane` for snapshots.
The model-facing surface should not expose tmux in tool names.

The plugin process owns the background control-mode subscriptions. Amp tool calls remain short,
bounded RPCs into that process. A task keeps running between tool calls, pane output is continuously
parsed inside the plugin subprocess, and configured task events can append a steering message back to
the originating Amp thread so the main agent learns about important background progress without
polling.

tmux is the authoritative state store. The plugin must not keep a filesystem registry. All durable
task metadata is stored in tmux user options (`@...`) on the tmux server/session/window/pane. The
plugin heap is only a cache plus active control-client connections.

```diagram
╭──────────────╮ background_task ╭──────────────────────╮ spawn/stdin/stdout ╭─────────────╮
│ Main agent   │────────────────▶│ Amp plugin process   │───────────────────▶│ tmux -C     │
│ thread       │◀────────────────│ BackgroundTaskManager│◀───────────────────│ backend     │
╰──────┬───────╯ result/snapshot ╰──────────┬───────────╯   %output stream   ╰──────┬──────╯
       ▲                                    │                                      │
       │ steering user message              │ terminal bytes                       │ owns PTY
       │ on interesting event               ▼                                      ▼
       │                          ╭──────────────────╮                  ╭──────────────────╮
       ╰──────────────────────────│ TaskState        │                  │ Interactive app  │
                                  │ rings + snapshots│                  │ bash, vim, amp…  │
                                  ╰──────────────────╯                  ╰──────────────────╯
```

## Goals

- Drive interactive terminal applications without waiting for shell-command completion.
- Inspect terminal state quickly from the live control client and tmux `capture-pane` snapshots.
- Avoid blocking the main agent thread on long-running terminal programs.
- Expose one model-facing tool with an `action` parameter; keep tmux as a backend detail.
- Let a task proactively notify the originating thread when a configured interesting event occurs.
- Support plugin-owned background tasks with clear lifecycle semantics.
- Store all durable task metadata in the backend, using tmux `@` user options for the tmux backend.
- Parse tmux control-mode output reliably in JavaScript, including byte streams, UTF-8 split points,
  ANSI control sequences, wide characters, combining marks, and tmux octal escapes.
- Keep lifecycle boundaries clear enough that reloads and crashes are safe.

## Non-goals

- Replace the normal `shell_command` or `bash` tools for non-interactive commands.
- Provide a full terminal UI inside Amp in the first iteration.
- Guarantee exact pixel rendering. The inspection surface is tmux's captured screen text, recent raw
  bytes/text, cursor/status metadata where available, and structured task metadata.
- Multiplex arbitrary many panes in the MVP. The design supports it, but the first tool UX should bias
  toward one primary pane per logical task.
- Attach to existing user-owned tmux sessions. External attach is a future extension because it adds
  socket discovery, ownership, routing, and destructive-action safety questions that are not needed
  for the first useful version.

## Current Amp constraints

- Plugin tools are registered with `amp.registerTool(...)`. Their `execute` handlers run in the plugin
  subprocess and return a single result to the main agent.
- The plugin runtime is already a separate Bun process. Long-lived subscriptions, child processes,
  timers, and ephemeral runtime caches can live there without blocking the main agent event loop.
- A tool call is still awaited by the agent. Therefore tools must be shaped as short async operations,
  not "run the interactive command until it exits".
- Plugin reload/dispose kills the plugin process. Any backend sessions that should survive reload must
  be explicitly marked and recoverable.
- The plugin API currently does not expose tool-call cancellation to plugin code. Every tool that waits
  must enforce its own timeout and return a partial state on timeout.

## Proposed tool surface

Expose exactly one model-facing tool:

```ts
background_task({
  action: 'start' | 'send' | 'snapshot' | 'wait' | 'resize' |
    'stop' | 'list' | 'configure_notifications',
  taskID?: string,
  ...actionSpecificFields,
})
```

The tool description should say that it manages interactive background terminal tasks. It should not
mention tmux in the name. The result can include backend metadata for debugging, but the primary handle
is always a logical `taskID`.

Why one tool:

- The model learns one affordance: "use `background_task` for long-lived interactive processes".
- Actions share one backend task metadata model, result envelope, notification policy, and safety
  model.
- Tool choice is simpler: the model chooses an action after deciding it needs the background-task
  capability.
- tmux remains replaceable by a future PTY, SSH, container, or platform-native backend.

### Common input fields

- `action: string` required.
- `taskID?: string` required for all actions except `start` and `list`.
- `includeSnapshot?: boolean` default true for mutating actions, true for `snapshot`, false for `list`.
- `pane?: string` optional logical or backend pane ID for future multi-pane support; defaults to the
  task's primary pane.

### Common result envelope

Every action returns a stable envelope:

```json
{
	"taskID": "bt_abc123",
	"action": "send",
	"status": "running",
	"message": "Sent input and observed 12 lines of output.",
	"snapshot": { "screen": "...", "recentOutput": "..." },
	"notification": { "enabled": true, "pending": 0 },
	"backend": { "kind": "tmux-control", "session": "$3", "pane": "%42" }
}
```

The backend object is optional and explicitly diagnostic. Model instructions should use `taskID`, not
tmux session IDs.

### `action: 'start'`

Start a new plugin-owned background task.

Inputs:

- `command: string` shell command or argv-like command string to run in the task.
- `cwd?: string` working directory; defaults to workspace root.
- `name?: string` human-readable task label.
- `cols?: number`, `rows?: number` initial terminal size; defaults to `120x40`.
- `env?: Record<string, string>` optional environment additions.
- `keepAlive?: boolean` if true, do not kill the backend session when the plugin reloads/disposes.
- `waitForIdleMs?: number` short initial idle wait before returning a snapshot.
- `notifications?: NotificationPolicy` optional proactive notification policy.
- `allowDuplicate?: boolean` default false. If false, a replayed or repeated equivalent start request
  returns the already-running task instead of spawning another copy.

Returns a new `taskID`, ownership metadata, initial snapshot, and notification status.

Start is idempotent by default. For non-duplicate starts, the plugin derives a stable `taskID` from
the workspace hash and normalized start signature: origin thread, name, cwd, command, environment
additions, and backend namespace. It stores the task metadata in tmux `@` user options on the tmux
session. If the same start action is replayed after an executor reconnect, the plugin discovers the
existing tmux session and metadata, verifies the task is still running, and returns the existing
`taskID` and current snapshot immediately. To intentionally run two identical commands, the caller
must use a different `name` or set `allowDuplicate: true`, which gives the task a unique suffix.

### External attach is out of scope

The first implementation does not expose an `attach` action for adopting existing user-owned tmux
sessions. The only model-facing way to create a task is `action: 'start'`, which creates a
plugin-owned session in the workspace tmux namespace.

External attach can be added later as an extension if there is strong demand. That extension should be
designed separately because it needs durable backend socket routing, safe ownership semantics,
read-only modes, and clear rules for resize/stop/kill against sessions the plugin did not create.

### `action: 'send'`

Send input to a task.

Inputs:

- `taskID: string`.
- `text?: string` literal UTF-8 text.
- `keys?: string[]` key names such as `Enter`, `C-c`, `Escape`, `Tab`, `Down`.
- `hexBytes?: string[]` optional ASCII/control-byte sends for cases where key names or literal text
  are ambiguous.
- `waitForIdleMs?: number` optional short wait after sending.

Returns send acknowledgement, output delta since the previous tool call for the task, and an optional
snapshot.

### `action: 'snapshot'`

Return current task state without sending input.

Inputs:

- `taskID: string`.
- `historyLines?: number` max scrollback/screen lines to include.
- `includeRawTail?: boolean` include recent raw terminal bytes as base64 for debugging.

Returns screen text, cursor row/col, dimensions, title if known, task status, process command, exit
status when available, output counters, truncation metadata, and recent delta.

### `action: 'wait'`

Wait for a bounded condition while the background parser continues to ingest output.

Inputs:

- `taskID: string`.
- `timeoutMs: number` required or default-capped.
- One of:
  - `idleMs`: no output for this long.
  - `contains`: screen or recent output contains text/regex.
  - `notContains`: text/regex disappears.
  - `exited`: task is dead or session closed.
- `includeSnapshot?: boolean` default true.

Returns `{ matched: boolean, reason, elapsedMs, delta, snapshot }`. Timeouts are normal results, not
plugin errors.

### `action: 'configure_notifications'`

Update proactive notification policy for an existing task.

Inputs:

- `taskID: string`.
- `notifications: NotificationPolicy`.

Returns the normalized policy and current notification counters.

This action must update the task's tmux `@amp.background-task.v1` metadata immediately. The plugin's
in-memory policy cache is not authoritative.

### `action: 'resize'`

Resize the task's terminal viewport.

Inputs: `taskID`, `cols`, `rows`, optional `pane/window`.

Uses backend-specific resizing, such as tmux `refresh-client -C` for control clients. Returns the new
dimensions and snapshot.

The new dimensions should be written back to tmux task metadata so a reattached plugin uses the same
viewport.

### `action: 'stop'`

Stop or detach a task.

Inputs:

- `taskID`.
- `mode: 'detach' | 'interrupt' | 'kill'`.
- `graceMs?: number` for interrupt before kill.

Rules:

- Plugin-owned tasks may be killed by default.
- When the plugin stops managing a task without killing the backend session, it should remove or mark
  its tmux `@amp.background-task.*` metadata according to the requested `keepAlive`/detach semantics.

### `action: 'list'`

List logical tasks known to the plugin, plus optional discovery of matching backend sessions by prefix.

## Notification policy

Notifications are part of the one-tool surface, not separate tools. They let the model start a task and
ask to be interrupted later when something useful happens.

```ts
interface NotificationPolicy {
	enabled: boolean
	/** Defaults to the thread that invoked start. */
	threadID?: string
	/** Use steering so the message is preferred when queued behind in-progress work. Default true. */
	steer?: boolean
	/** Minimum time between injected messages for this task. */
	cooldownMs?: number
	/** Delay notification until matching output has been quiet for this long. */
	debounceMs?: number
	/** Maximum injected messages before notifications auto-disable. */
	maxMessages?: number
	triggers: NotificationTrigger[]
}

type NotificationTrigger =
	| { type: 'exit'; includeSnapshot?: boolean }
	| { type: 'idle'; idleMs: number; afterOutput?: boolean; includeSnapshot?: boolean }
	| { type: 'contains'; pattern: string; regex?: boolean; includeSnapshot?: boolean }
	| { type: 'notContains'; pattern: string; regex?: boolean; includeSnapshot?: boolean }
	| { type: 'error-output'; includeSnapshot?: boolean }
```

MVP defaults should be conservative:

- If `notifications` is omitted, enable only `exit` for long-running plugin-owned tasks.
- If the model wants richer behavior, it should configure explicit triggers such as `contains` or
  `idle`.
- Avoid a vague "notify on anything interesting" default. Deterministic triggers are easier to test,
  cheaper, and less likely to spam the thread.

### Notification policy examples

#### Dev server readiness and crashes

Use this when starting a server that should keep running while the agent edits code. Notify when the
server becomes ready, when obvious errors appear, and if it exits unexpectedly.

```ts
background_task({
	action: 'start',
	name: 'dev server',
	command: 'pnpm dev',
	notifications: {
		enabled: true,
		steer: true,
		debounceMs: 1_000,
		cooldownMs: 30_000,
		maxMessages: 5,
		triggers: [
			{ type: 'contains', pattern: 'Local:', includeSnapshot: true },
			{ type: 'contains', pattern: 'Error:', includeSnapshot: true },
			{ type: 'contains', pattern: 'failed', includeSnapshot: true },
			{ type: 'exit', includeSnapshot: true },
		],
	},
})
```

Expected injected message:

```text
Background task bt_dev reported: matched "Local:".

The dev server appears ready.

Recent output:
  Local: http://localhost:5173/
```

#### Test watcher result changes

Use this for watch-mode tests. The agent can continue editing while the task reports pass/fail state
changes. A cooldown avoids one message per file-change burst.

```ts
background_task({
	action: 'start',
	name: 'test watcher',
	command: 'pnpm test -- --watch',
	notifications: {
		enabled: true,
		debounceMs: 1_500,
		cooldownMs: 20_000,
		maxMessages: 10,
		triggers: [
			{ type: 'contains', pattern: 'Test Files  0 failed', includeSnapshot: true },
			{ type: 'contains', pattern: 'failed', includeSnapshot: true },
			{ type: 'idle', idleMs: 2_000, afterOutput: true, includeSnapshot: true },
			{ type: 'exit', includeSnapshot: true },
		],
	},
})
```

Expected injected message:

```text
Background task bt_tests reported: terminal idle for 2000ms after output.

Recent output:
Test Files  1 failed | 24 passed
Tests       3 failed | 141 passed
```

#### Interactive CLI prompt detection

Use this when driving an interactive CLI or TUI where the task should notify the agent when a prompt
or menu becomes available.

```ts
background_task({
	action: 'start',
	name: 'amp cli',
	command: 'NO_ANIMATION=1 NO_SPLASH_QUOTE=1 pnpm -C cli cli',
	notifications: {
		enabled: true,
		debounceMs: 500,
		cooldownMs: 10_000,
		maxMessages: 8,
		triggers: [
			{ type: 'contains', pattern: 'What would you like to do?', includeSnapshot: true },
			{ type: 'contains', pattern: 'Command Palette', includeSnapshot: true },
			{ type: 'contains', pattern: 'Error', includeSnapshot: true },
			{ type: 'exit', includeSnapshot: true },
		],
	},
})
```

Expected injected message:

```text
Background task bt_cli reported: matched "Command Palette".

The interactive CLI is waiting at the command palette.
Use background_task action="send" with taskID="bt_cli" to select an item.
```

#### Node debugger breakpoint workflow

Use this when the agent needs to drive an interactive debugger, continue execution, and get notified
when execution stops at a breakpoint, prompt, exception, or process exit.

Start the debugger as a background task:

```ts
background_task({
	action: 'start',
	name: 'node debugger',
	command: 'node inspect ./scripts/repro.js',
	notifications: {
		enabled: true,
		steer: true,
		debounceMs: 500,
		cooldownMs: 5_000,
		maxMessages: 20,
		triggers: [
			{ type: 'contains', pattern: 'debug>', includeSnapshot: true },
			{ type: 'contains', pattern: 'break in ', includeSnapshot: true },
			{ type: 'contains', pattern: 'Breakpoint', includeSnapshot: true },
			{ type: 'contains', pattern: 'Uncaught', includeSnapshot: true },
			{ type: 'contains', pattern: 'Exception', includeSnapshot: true },
			{ type: 'exit', includeSnapshot: true },
		],
	},
})
```

Initial injected message when the debugger reaches its prompt:

```text
Background task bt_debug reported: matched "debug>".

Recent output:
break in ./scripts/repro.js:1
> 1 const { run } = require('../dist/repro')
  2 run()
debug>
```

The agent can now set a breakpoint and continue without blocking the main thread:

```ts
background_task({
	action: 'send',
	taskID: 'bt_debug',
	text: "setBreakpoint('src/cache.js', 87)\ncont\n",
	includeSnapshot: true,
})
```

When the breakpoint is hit later, the plugin appends a steering update:

```text
Background task bt_debug reported: matched "break in ".

Recent output:
break in src/cache.js:87
 85   const key = normalize(input)
 86   const entry = cache.get(key)
>87   return entry.value
 88 }
debug>
```

The agent can inspect state, step, or continue through the same task:

```ts
background_task({
	action: 'send',
	taskID: 'bt_debug',
	text: 'exec JSON.stringify({ key, entry }, null, 2)\nnext\n',
	waitForIdleMs: 500,
	includeSnapshot: true,
})
```

If the debugger pauses on an exception, the notification should include the exception text and a
snapshot so the agent can decide whether to inspect stack/state or stop the task:

```text
Background task bt_debug reported: matched "Uncaught".

Recent output:
Uncaught TypeError: Cannot read properties of undefined (reading 'value')
    at getCachedValue (src/cache.js:87:16)
debug>
```

This workflow is the main reason notifications should be task-owned instead of a separate polling
tool: the model can start the debugger, continue execution, go work on another file, and only re-enter
the debugger when it actually stops somewhere useful.

#### Long build or migration completion

Use this for long-running one-shot commands where the agent only needs to know when the task exits or
prints a known completion marker.

```ts
background_task({
	action: 'start',
	name: 'database migration',
	command: 'pnpm migrate:dev',
	notifications: {
		enabled: true,
		cooldownMs: 60_000,
		maxMessages: 3,
		triggers: [
			{ type: 'contains', pattern: 'Migration complete', includeSnapshot: true },
			{ type: 'contains', pattern: 'ROLLBACK', includeSnapshot: true },
			{ type: 'exit', includeSnapshot: true },
		],
	},
})
```

Expected injected message:

```text
Background task bt_migration reported: process exited with status 1.

Recent output:
ROLLBACK: duplicate key value violates unique constraint
```

#### Quiet background process with only exit notification

Use this when the model should not be interrupted unless the process finishes. This is the safest
default for noisy or secret-bearing output.

```ts
background_task({
	action: 'start',
	name: 'artifact upload',
	command: 'scripts/upload-artifacts.sh',
	notifications: {
		enabled: true,
		cooldownMs: 60_000,
		maxMessages: 1,
		triggers: [{ type: 'exit', includeSnapshot: false }],
	},
})
```

Expected injected message:

```text
Background task bt_upload reported: process exited with status 0.
```

## Ownership model

There are three separate things to own: the backend session, the control-mode client connection, and
the logical Amp task handle.

### Plugin-owned tasks

- Created only by `background_task({ action: 'start', ... })`.
- Namespaced by workspace and plugin, for example:
  `amp-driver-${workspaceHash}-${shortID}`.
- Created on a dedicated tmux socket namespace where possible, for example:
  `tmux -L amp-driver-${workspaceHash} ...`.
- Default lifecycle: killed on `background_task({ action: 'stop', ... })`, plugin graceful dispose,
  or stale-session cleanup after a plugin crash/restart.
- `keepAlive: true` changes default cleanup to detach-only and allows later recovery.
- The plugin writes metadata into tmux `@` user options so a later plugin process can identify stale
  or recoverable sessions without reading any filesystem registry.

### Control-mode client connections

- Always plugin-owned.
- One control client per logical task in the MVP.
- Spawned as a child process from the plugin subprocess, not through `amp.$`, because stdin/stdout
  must remain attached to the tmux control protocol.
- The client process is disposable and restartable. If it exits but the backend session still exists, the
  manager can reattach and reconcile pane state.

### Amp logical task handles

- Runtime records keyed by `taskID` are cache only.
- Durable fields such as raw tmux IDs, primary pane, dimensions, notification policy, originating
  thread ID, start signature, and cleanup policy are read from tmux `@` user options.
- Do not persist full terminal output unless the user explicitly requests an artifact. Use tmux
  scrollback and `capture-pane` for recoverable screen state.

## Backend-authoritative state

The tmux backend is the source of truth. The plugin should be able to restart with an empty heap,
derive the workspace socket name from the workspace hash, connect to tmux, list sessions, read `@`
metadata, and reconstruct all known tasks.

Recommended custom options:

- Server scope:
  - `@amp.background-task.workspace`: workspace hash and schema version for this tmux socket.
- Session scope:
  - `@amp.background-task.v1`: compact JSON metadata blob for one task.
  - `@amp.background-task.start-key`: normalized idempotency key for non-duplicate starts.
  - `@amp.background-task.task-id`: logical task ID, duplicated outside the JSON for easy filtering.
- Pane scope, only if needed later:
  - `@amp.background-task.pane-role`: `primary`, `auxiliary`, debugger console, etc.

The session-level JSON blob should be small and stable:

```json
{
	"schemaVersion": 1,
	"taskID": "bt_abc123",
	"workspaceHash": "w_123",
	"owner": "plugin",
	"name": "node debugger",
	"originThreadID": "T-...",
	"startKey": "sha256:...",
	"command": "node inspect ./scripts/repro.js",
	"cwd": "/repo",
	"env": {},
	"createdAt": 1780574077000,
	"keepAlive": false,
	"primaryPane": "%42",
	"dimensions": { "cols": 120, "rows": 40 },
	"notifications": { "enabled": true, "triggers": [] },
	"notificationState": {
		"sentCount": 0,
		"lastSentAt": null,
		"lastTriggerKey": null
	}
}
```

The plugin may cache this metadata in memory while attached, but every mutation that matters after a
restart must be written back to tmux immediately with `set-option`/`show-options`. No `.amp/in` JSON
registry is part of the design.

## Backend persistability review

All user-visible task configuration and recovery data can live in tmux:

- Task identity: `taskID`, workspace hash, start key, plugin owner marker, name.
- Backend routing: tmux socket name, session/window/pane IDs, primary pane.
- Start configuration: command, cwd, env additions, dimensions.
- Lifecycle policy: keepAlive, cleanup mode, created/last-activity timestamps.
- Notification policy and state: triggers, debounce/cooldown, max message count, sent count, last
  sent timestamp, last trigger key.
- Recovery state: enough metadata to reattach a control client after plugin reload.

Runtime-only state that should not be treated as durable:

- Active control-mode client processes. Recreate them by attaching to the tmux session.
- In-flight `action: 'wait'` promises. If Amp replays the tool call, the wait is re-established; if not,
  there is no user-visible durable waiter to recover.
- Debounce timers. Persist the inputs (`lastTriggerKey`, timestamps, counters) in tmux and recreate
  timers on attach.
- Output rings and recent-output deltas. They are a performance/context cache. After restart, use tmux
  history plus `capture-pane` for screen state and start new live deltas from the reattached control
  stream.

Flagged limitations to confirm before implementation:

- A trigger for output that appears while the plugin is down can only be recovered if the evidence is
  still present in tmux history, the current screen, pane exit status, or persisted metadata. A very
  transient string that appears and disappears while no control client is attached is not guaranteed to
  produce a notification after restart.
- Exact "recent output since the previous tool result" is not guaranteed across plugin restart unless
  we persist a stronger cursor/checkpoint in tmux metadata. The MVP can return a fresh captured screen
  and new deltas from the reattached control stream.
- tmux user option value limits are not specified in this RFC. Keep metadata small and split it across
  multiple `@amp.background-task.*` options if needed; do not store transcripts in options.

## Lifecycle

### Plugin load

1. Construct a singleton `BackgroundTaskManager` at module load.
2. Register tools.
3. Compute `workspaceHash` and tmux socket name.
4. Connect to the tmux socket if it exists; otherwise start with an empty task set.
5. Read server/session/window/pane `@amp.background-task.*` options and reconstruct task records.
6. Optionally reap stale plugin-owned tasks where:
   - `keepAlive` is false,
   - the metadata is older than a TTL or otherwise known stale,
   - session name matches this workspace namespace.
7. Reattach eagerly only to keepAlive tasks with enabled notifications, because they promised
   proactive updates.
8. Reattach other old tasks lazily from `action: 'list'` or a `start` recovery option.

### Start flow

1. Validate command, cwd, dimensions, and limits.
2. Compute the normalized start signature and check tmux `@` metadata plus tmux state. If an
   equivalent task is already running and `allowDuplicate` is false, return the existing `taskID`,
   status, and snapshot.
3. Derive or generate a `taskID` and choose a tmux session name that includes it, so even a partially
   initialized session is discoverable after a crash.
4. Create a tmux session detached, with `remain-on-exit` enabled for plugin-owned sessions so exit
   status can be inspected via `pane_dead_status`.
5. Capture raw tmux IDs with formats such as `#{session_id}`, `#{window_id}`, `#{pane_id}`.
6. Write all durable task metadata into tmux `@amp.background-task.*` options.
7. Spawn `tmux -C attach-session -t <session>` as the control client.
8. Set control-client size with `refresh-client -C <cols>x<rows>`.
9. Subscribe to pane output. If using `pause-after`, handle `%pause`/`%continue` notifications.
10. Initialize the runtime cache from tmux metadata and return after attach plus a short bounded idle
    wait.

### Send flow

1. Resolve logical `taskID` and pane.
2. Encode text/key input into one or more tmux commands.
3. Queue those commands on the `ControlClient` command queue.
4. Wait only for tmux command acknowledgement and optional short idle.
5. Return output delta and snapshot.

### Inspect flow

1. Read current `PaneState` maintained by the output stream.
2. Send `capture-pane` through the control client to get tmux's current visible contents and optional
   scrollback tail.
3. Return the captured screen plus capped recent-output deltas from memory.

### Wait flow

1. Register a waiter against the task/pane state.
2. Evaluate the condition immediately.
3. Re-evaluate on each output notification, pane lifecycle notification, and a timeout timer.
4. Resolve with a normal timeout result if not matched before `timeoutMs`.

### Notification flow

1. Convert parser updates into candidate task events: output, idle, pattern match, pause, resume,
   exit, or backend disconnect.
2. Evaluate the task's `NotificationPolicy` against each candidate event.
3. Apply de-duplication, `debounceMs`, `cooldownMs`, and `maxMessages` before notifying.
4. Compose a concise background-task update with task ID, reason, status, recent output, and optional
   snapshot.
5. Append that update to the originating thread with steering enabled by default.
6. Persist updated `notificationState` back into tmux `@` metadata before considering the notification
   complete.

### Dispose/reload flow

1. Reject pending command promises and waiters with a disposal result.
2. Detach or kill control clients.
3. For plugin-owned tasks with `keepAlive !== true`, send `kill-session` on the dedicated socket.
4. For plugin-owned `keepAlive` tasks, detach only and leave tmux `@` metadata for recovery.

### Crash recovery

- If the plugin process crashes, graceful cleanup may not run.
- On next load, stale plugin-owned tasks are recognized by tmux session name and `@` metadata.
- Default policy should reap stale non-keepAlive tasks, because otherwise invisible interactive
  processes accumulate.
- KeepAlive tasks can be listed and reattached.
- KeepAlive tasks with enabled notifications should be reattached automatically so promised proactive
  updates resume after plugin reload.

## Proactive context injection

The model-facing behavior should be: "start a background task, optionally configure what to watch for,
then continue other work; if the task hits a trigger, Amp will add a message to this thread."

The plugin can implement this with existing plugin APIs:

1. When `background_task({ action: 'start' })` runs, capture `ctx.thread.id` as the task's default
   notification destination.
2. Background parser callbacks run outside a tool invocation, so they cannot use a tool context. They
   should call `amp.experimental.threads.get(threadID).appendUserMessage(...)` from the plugin-level
   API instead.
3. Use `{ steer: true }` by default so if the thread is busy, the notification is preferred at the
   next interruption/dequeue point.
4. Prefix injected messages clearly so the model knows the message is a plugin-generated background
   event, not a human instruction.

The core operation is:

```ts
await amp.experimental.threads
	.get(threadID)
	.appendUserMessage(
		{ type: 'user-message', content: formatBackgroundTaskEvent(event) },
		{ steer: true },
	)
```

Example injected message:

```text
Background task bt_abc123 reported: process exited with status 0.

Recent output:
<capped terminal output>
```

### Semantics and limitations

- This is not literal mutation of a model request that is already in flight. It appends a user message
  to the thread. In thread-actor-backed Amp, if the thread is busy, that message queues durably; with
  `steer: true`, it is preferred when queued work is next considered.
- This is still enough for the intended workflow: the main agent can start a task, do other work, and
  then receive a background-task update as soon as Amp can safely include it in context.
- If we need true mid-inference injection later, Amp would need a core protocol feature for background
  events that cancels/restarts or patches an active inference turn. That should not block the plugin
  MVP.

### Notification message quality and rate limits

- Injected messages must be concise and capped. Include truncation metadata.
- Suppress duplicate notifications for the same output sequence and trigger.
- Debounce bursty triggers so a test watcher, compiler, or debugger pause produces one useful update
  after the output settles, not one message per line.
- Never inject raw unlimited terminal output; it can flood context.
- No special prompt-injection boundary is needed beyond the normal command-output handling Amp already
  does. The agent is already operating in a workspace where it can run arbitrary commands; background
  task output has the same standing as ordinary terminal output.

## Control-mode protocol handling

tmux control mode is line framed on stdout:

- Commands are sent as tmux command lines on stdin.
- Each command response is a block:
  - `%begin <time> <command-number> <flags>`
  - zero or more output lines
  - `%end ...` or `%error ...`
- Notifications never occur inside command output blocks.
- Pane output is delivered as `%output <pane-id> <value>` or `%extended-output <pane-id> <age> ... : <value>`.
- In `%output`, tmux escapes non-printable bytes and backslash as octal `\xxx`.

### Parser architecture

Use a byte-oriented finite state machine instead of `readline` or `chunk.toString().split('\n')`.

```diagram
╭─────────────╮ bytes  ╭────────────────╮ lines  ╭────────────────────╮ events ╭──────────────╮
│ child.stdout│───────▶│ ByteLineFramer │───────▶│ ControlModeParser  │───────▶│ Driver state │
╰─────────────╯        ╰────────────────╯        ╰────────────────────╯        ╰──────────────╯
                                                        │
                                                        │ pane payload bytes for deltas/triggers
                                                        ▼
                                              ╭────────────────────╮
                                              │ Pane text decoder  │
                                              │ + bounded rings    │
                                              ╰────────────────────╯

Snapshots are separate: `background_task({ action: 'snapshot' })` sends a tmux `capture-pane`
command through the same control client and returns tmux's current pane contents.
```

Components:

- `ByteLineFramer`
  - Accumulates `Uint8Array` chunks.
  - Splits only on byte `0x0a`.
  - Strips one preceding `0x0d` if present.
  - Preserves all other bytes untouched.
- `ControlModeParser`
  - Parses ASCII control keywords and arguments from bytes.
  - Maintains state: `outsideBlock` or `insideCommandBlock`.
  - Emits `CommandBlock`, `CommandError`, `PaneOutput`, `PaneExtendedOutput`, `Notification`, and
    `ClientExit` events.
- `OutputUnescaper`
  - Operates on bytes from the `%output` value field.
  - Converts ASCII backslash-octal sequences `\000` through `\377` to one byte.
  - Copies ordinary payload bytes unchanged.
  - Treats malformed escapes as protocol errors with enough context to debug, not silent corruption.
- `CommandQueue`
  - Allows only one outstanding tmux command at a time for MVP reliability.
  - Resolves the next queued command on the next `%end`/`%error` block.
  - Notifications may interleave between command blocks and are handled immediately.

The command queue can be relaxed later if tmux guarantees block ordering sufficiently for concurrent
commands, but one-at-a-time command execution is simpler and fast enough because the expensive path is
pane output, not command acknowledgement.

### `%extended-output`

When the control client uses `pause-after`, tmux may send `%extended-output`:

```text
%extended-output <pane-id> <age-ms> ... : <value>
```

Parse arguments until the standalone `:` token; ignore future extension arguments between `age-ms` and
`:`. The value after `:` is decoded with the same octal-byte unescaper as `%output`. Record `age-ms` as
backpressure telemetry.

### Backpressure

- Use bounded in-memory rings per pane:
  - raw byte ring, for debugging/replay;
  - decoded text/output event ring, for wait conditions and deltas;
  - snapshot cache containing the latest capped `capture-pane` result.
- Prefer tmux client flags such as `pause-after=1` so tmux pauses pane output if the plugin falls
  behind.
- On `%pause <pane-id>`, mark the pane paused. After the parser drains pending bytes and ring buffers
  are within limits, send `refresh-client -A <pane-id>:continue`.
- If a pane continuously outputs faster than the plugin can process, drop oldest ring entries with
  explicit truncation counters rather than growing memory unbounded.

## JavaScript UTF-16 and terminal-byte handling

The most important reliability rule is: terminal I/O is bytes; JavaScript strings are UTF-16 code
units. Do not use JS string offsets as byte offsets or terminal-cell offsets.

### Output path

1. Read `child.stdout` as `Buffer`/`Uint8Array`, not pre-decoded strings.
2. Line-frame the tmux protocol by byte newline.
3. Parse control keywords as ASCII bytes.
4. For `%output` values, octal-unescape to raw terminal bytes.
5. Feed raw terminal bytes into a per-pane streaming `TextDecoder('utf-8')`.
   - This preserves Unicode code points split across tmux output notifications.
   - Use `{ stream: true }` for all normal chunks and flush only when the pane closes.
6. Use decoded text for recent-output deltas and notification matching.
7. For model-facing screen snapshots, ask tmux for the pane contents with `capture-pane` through the
   control client. tmux already owns the terminal grid, alternate screen, wrapping, wide characters,
   and combining marks, so the plugin does not need its own terminal emulator.

### Why this avoids corruption

- A UTF-8 character such as `é` can be split between two `%output` notifications. If each protocol
  line is decoded independently, replacement characters can be introduced. A per-pane streaming
  decoder avoids that.
- Emoji and many CJK characters occupy multiple UTF-16 code units and/or multiple terminal columns.
  Do not compute screen width from JS `string.length`; use tmux `capture-pane` for screen layout.
- Combining marks may be separate Unicode code points but one displayed cell. Let tmux produce the
  displayed text for snapshots; use JS strings only for recent-output matching and capped deltas.

### Input path

- Split input into two explicit modes:
  - literal text via `send-keys -l`;
  - symbolic keys via `send-keys <key-name>` or byte/control input via `send-keys -H`.
- Implement one tested tmux command-argument encoder.
  - It must produce a single-line tmux command.
  - It must quote spaces, semicolons, backslashes, quotes, `$`, and newlines safely.
  - It should encode non-ASCII text with tmux-supported Unicode or byte escapes rather than relying
    on shell quoting.
- Never build tmux commands through a shell string. Spawn `tmux` directly and write control commands
  to the control client's stdin.

## Internal data model

```ts
interface PersistedTaskMetadata {
	id: string
	owner: 'plugin'
	name: string
	originThreadID: string
	tmuxSocketName: string
	tmuxSession: string
	tmuxWindow: string
	primaryPane: string
	startKey: string
	command: string
	cwd: string
	env: Record<string, string>
	keepAlive: boolean
	notifications: NotificationPolicy
	notificationState: NotificationState
	createdAt: number
	lastActivityAt: number
}

interface RuntimeTaskCache {
	metadata: PersistedTaskMetadata
	control: ControlClient
	panes: Map<string, PaneState>
}

interface ControlClient {
	state: 'starting' | 'attached' | 'exited' | 'reconnecting' | 'disposed'
	sendCommand(command: TmuxCommand, timeoutMs: number): Promise<CommandResult>
	dispose(mode: 'detach' | 'kill-client'): Promise<void>
}

interface PaneState {
	paneID: string
	decoder: TextDecoder
	rawRing: ByteRing
	textRing: OutputRing
	latestSnapshot?: PaneSnapshot
	lastOutputAt: number
	paused: boolean
	dead: boolean
	exitStatus?: number
	exitSignal?: string
}
```

Exact TypeScript names can change, but these boundaries should remain: tmux `@` options own durable
task metadata, the manager owns an ephemeral runtime cache, control clients own tmux protocol I/O and
`capture-pane` snapshots, parser emits typed events, pane state owns bounded output rings, and the
notification evaluator owns context-injection decisions.

## Session creation details

Recommended creation sequence for plugin-owned sessions:

1. Choose socket namespace and session name.
2. Create detached session with explicit size and cwd:

   ```sh
   tmux -L "$socket" new-session -d -s "$session" -x "$cols" -y "$rows" -c "$cwd" -- "$command"
   ```

3. Enable lifecycle inspection:

   ```sh
   tmux -L "$socket" set-option -t "$session" remain-on-exit on
   ```

4. Query IDs:

   ```sh
   tmux -L "$socket" list-panes -t "$session" -F '#{session_id} #{window_id} #{pane_id}'
   ```

5. Store task metadata in tmux user options:

   ```sh
   tmux -L "$socket" set-option -t "$session" @amp.background-task.task-id "$taskID"
   tmux -L "$socket" set-option -t "$session" @amp.background-task.start-key "$startKey"
   tmux -L "$socket" set-option -t "$session" @amp.background-task.v1 "$metadataJSON"
   ```

6. Attach control client:

   ```sh
   tmux -L "$socket" -C attach-session -t "$session"
   ```

7. Send `refresh-client -C ${cols}x${rows}` through the control client.
8. For snapshots, send `capture-pane -p` through the same control client. Use explicit `-S`/`-E`
   bounds for scrollback tails and alternate-screen flags when needed for TUIs.

Implementation should use `spawn` argument arrays, not shell interpolation. The shell snippets above
are illustrative only.

## Result shaping for the agent

Tool results should be concise and stable. A snapshot should include:

```json
{
	"taskID": "bt_abc123",
	"action": "snapshot",
	"paneID": "%42",
	"status": "running",
	"dimensions": { "cols": 120, "rows": 40 },
	"cursor": { "row": 12, "col": 8 },
	"screen": "...visible terminal text...",
	"recentOutput": "...delta since previous interaction...",
	"notification": { "enabled": true, "lastReason": "idle" },
	"truncation": {
		"screenLinesOmitted": 0,
		"recentOutputBytesOmitted": 12048
	},
	"backend": {
		"kind": "tmux-control",
		"session": "$3",
		"window": "@5",
		"pane": "%42"
	}
}
```

Default caps should protect context and memory:

- visible screen plus a small scrollback tail;
- recent delta capped by bytes and lines;
- raw byte tail only on request;
- explicit truncation metadata whenever data is omitted.

## Error model

- Invalid user input: return a normal tool error string explaining the bad parameter.
- tmux command `%error`: return a tool error for the current operation and keep the task alive if
  possible.
- Control client exits:
  - reject pending command;
  - mark task `reconnecting` if the tmux session still exists;
  - otherwise mark task `closed`.
- Pane exits:
  - mark pane dead;
  - query `pane_dead_status`, `pane_dead_signal`, and `pane_dead_time` if `remain-on-exit` is active;
  - do not treat normal pane exit as plugin failure.
- Parser protocol violation:
  - log raw escaped context;
  - restart the control client once;
  - if it repeats, mark the task degraded and recommend detach/reattach.

## Security and safety

- This plugin should only run on local executors with tmux installed. If `amp.system.executor.kind` is
  remote or unknown, the tools should clearly report that tmux driving is local-only unless explicitly
  enabled.
- Do not use shell interpolation for tmux control commands or user text.
- Do not attach to or kill arbitrary user sessions in the MVP. Only operate on plugin-owned sessions
  with valid `@amp.background-task.*` metadata for this workspace.
- Namespaces and tmux `@` metadata should include the workspace hash to avoid cross-workspace cleanup.
- Limit concurrent tasks and total buffered output.
- Avoid persisting raw terminal output by default because it can contain secrets.

## Testing strategy

### Unit tests

- Byte line framing across arbitrary chunk boundaries.
- `%begin`/`%end` command block parsing with interleaved notifications.
- `%output` and `%extended-output` parsing.
- Octal unescape for `\000`, `\012`, `\134`, `\377`, malformed escapes, and ordinary UTF-8 bytes.
- UTF-8 split across output notifications, including emoji and CJK.
- Input tmux argument encoder with semicolons, quotes, backslashes, newlines, control characters, and
  non-ASCII text.
- Waiter matching and timeout behavior.

### Integration tests with real tmux

- Start `bash`, send `echo hello`, wait for idle, inspect screen.
- Start a Node or Python REPL, send multi-line input, inspect prompt and output.
- Run an alternate-screen app if available (`vim`, `less`, or Amp CLI), send navigation keys, inspect
  visible screen.
- Verify pane exit status with `remain-on-exit`.
- Kill/restart the control client while the tmux session continues, then reattach.
- Plugin-owned cleanup on graceful dispose and stale cleanup on next load.

### Manual dogfood

- Drive `pnpm -C cli cli` in a tmux session.
- Compare latency and correctness against the old pattern of only polling `capture-pane` after each
  action.
- Record cases where the screen and raw output diverge; decide whether they require parser fixes or
  different `capture-pane` flags.

## REPL generalization

The Node debugger workflow is one instance of a broader REPL pattern:

1. Start a long-lived interactive process.
2. Wait for a prompt, breakpoint, menu, idle period, or completion marker.
3. Send one or more commands.
4. Let the task run in the background.
5. Re-enter when a deterministic trigger says the process is ready or has failed.

This applies to debuggers (`node inspect`, `gdb`, `lldb`, `pdb`), language shells (`node`, `python`,
`irb`), database CLIs (`psql`, `sqlite3`, `redis-cli`), cloud CLIs with interactive login/device-code
flows, custom project REPLs, and TUIs when tmux `capture-pane` can produce a useful screen snapshot.

The only difference between REPLs is the trigger vocabulary. For a line REPL it is often the prompt
string plus `idle`; for a debugger it is prompt/breakpoint/exception markers; for a TUI it is screen
text or idle after key input. The same `background_task` actions and notification policy cover all of
them.

## MVP implementation slice

1. Single project plugin file plus small local test helpers if needed.
2. One tool: `background_task`, with `action` values for `start`, `send`, `snapshot`, `wait`,
   `configure_notifications`, `resize`, `stop`, and `list`.
3. One control client and one primary pane per logical task.
4. Byte parser, octal unescaper, command queue, bounded rings.
5. Use tmux `capture-pane` for snapshots; do not add a terminal-emulator dependency in the MVP.
6. Proactive notification injection through `amp.experimental.threads.get(threadID).appendUserMessage`
   with `{ steer: true }` by default.
7. Plugin-owned cleanup and keepAlive recovery semantics.

## Future extensions

- Multi-pane routing and pane selection fields/actions within the same `background_task` tool.
- External attach for adopting user-owned tmux sessions, with explicit socket routing, read-only mode,
  and destructive-action safety semantics.
- Native background-event messages in Amp, so plugin-generated task updates are represented as info
  events instead of appended user messages.
- Rich UI panel or status item showing active tasks.
- Persisted transcript artifacts for a task on demand.
- Promote parser and snapshot code into core for reuse by builtin tools.
- Optional per-task policies: max runtime, max output bytes, idle auto-stop.

## Open questions

### Resolved design decisions

- **Prompt injection is not a special concern.** Background task output has the same standing as
  ordinary command output. Amp already operates in a workspace where the agent can run arbitrary
  commands, so proactive task output does not introduce a qualitatively new trust boundary.
- **Idempotency is tmux-metadata based.** The stable identifier is the plugin-issued `taskID`, stored
  in tmux `@` options and reflected in the tmux session name. Replayed `start` actions check tmux
  metadata and tmux state; if the task is already running, the plugin returns the existing `taskID`
  and current snapshot immediately.
- **Notification loops are controlled by policy.** Use debounce, cooldowns, output-sequence de-dupe,
  max-message limits, and auto-disable-on-repeat rather than adding a separate mechanism.
- **No terminal emulator dependency in the MVP.** The control client can always issue `capture-pane`
  to tmux for current contents. The parser still tracks live output for deltas and triggers, but tmux
  owns the screen snapshot.

### Remaining decisions that are not blockers

- **Tool name.** `background_task` is descriptive enough for the RFC, but `interactive_task` or
  `background_terminal` could be reconsidered before implementation. The important decision is one
  tool with an `action` parameter.
- **`keepAlive` default.** Recommendation: false for plugin-owned tasks, true only when requested.
- **Pure plugin vs core-backed plugin.** Recommendation: start as a project plugin, but move parser
  tests/core abstractions into core if it becomes a standard Amp tool.
- **Output caps.** Recommendation: visible screen plus recent delta by default, with explicit opt-in
  for larger scrollback/raw bytes.
- **Intentional duplicate starts.** Recommendation: default to idempotent start by normalized
  signature; require a different `name` or `allowDuplicate: true` for two identical commands.
- **Plugin cancellation API.** Not required for MVP if `background_task` `action: 'wait'` requires or
  caps `timeoutMs`, and timeouts return normal tool results.

### Deal-breaker assessment

There are no fundamental deal breakers for a prototype. tmux control mode gives us the right byte
stream and command channel, `capture-pane` gives us snapshots without a terminal emulator, and Amp
plugins already run in a separate process with thread append APIs.

For production quality, the main requirement is making the tmux metadata/reconnect path reliable:
derive stable task IDs, write `@` metadata immediately, recover keepAlive tasks on reload, and verify
tmux state before confirming replayed starts. That is implementation work, not a design blocker.
