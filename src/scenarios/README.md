# Background task scenario runner design

The scenario runner should compile declarative HTML scenario files into a small set of
`background_task` operations, run those operations through an in-process harness, record a canonical
operation log, and evaluate semantic assertions against that log and the current task state.

```diagram
╭───────────────╮
│ scenario.html │
╰───────┬───────╯
        ▼
╭─────────────────────╮
│ HTML scenario parser│  Bun HTMLRewriter
╰───────┬─────────────╯
        ▼
╭────────────────────╮
│ Scenario AST       │  run steps, assertions, cleanup, expected state
╰───────┬────────────╯
        ▼
╭────────────────────╮
│ Runner             │  creates manager, sends tool inputs
╰───────┬────────────╯
        ▼
╭────────────────────╮
│ Operation log      │  requests, raw responses, canonical responses, events
╰───────┬────────────╯
        ▼
╭────────────────────╮
│ Assertion evaluator│  semantic + canonical field assertions
╰───────┬────────────╯
        ▼
╭────────────────────╮
│ Reporter / updater │  pass/fail/xfail/xpass, optional expectation updates
╰────────────────────╯
```

The key idea is that HTML describes scenario intent and the runner owns technical details such as
socket transport, response-shape normalization, task alias resolution, script materialization,
cleanup, and reporting.

## Scenario file structure

Every scenario should use this rough skeleton:

```html
<scenario id="interactive-send" expected="pass">
	<summary>Text and keys sent to an interactive task become visible in task output.</summary>

	<defaults wait-for-idle-ms="200" history-lines="40" />

	<setup>
		<!-- Optional fixtures, e.g. temporary scripts or project files. -->
	</setup>

	<run>
		<!-- High-level background_task operations. -->
	</run>

	<then>
		<!-- Assertions against operation log or current state. -->
	</then>

	<cleanup>
		<!-- Always attempted, even after failure. -->
	</cleanup>
</scenario>
```

Example:

```html
<scenario id="interactive-send" expected="pass">
	<summary>Text and keys sent to an interactive task become visible in task output.</summary>

	<defaults wait-for-idle-ms="200" />

	<run>
		<bt-start id="reader" name="line-reader">
			<script type="application/javascript">
				process.stdin.setEncoding('utf8')
				let buffered = ''
				for await (const chunk of process.stdin) {
					buffered += chunk
					const lines = buffered.split('\n')
					buffered = lines.pop() ?? ''
					for (const line of lines) console.log(`saw:${line.replace(/\r$/, '')}`)
				}
			</script>
		</bt-start>

		<bt-send task="reader">
			hello
			<key>Enter</key>
		</bt-send>

		<bt-wait id="echoed" task="reader" timeout-ms="2000">
			<contains>saw:hello</contains>
		</bt-wait>
	</run>

	<then>
		<expect-step step="echoed" action="wait" matched="true">
			<field name="snapshot.screen">
				<contains>saw:hello</contains>
			</field>
		</expect-step>

		<expect-output task="reader">
			<contains>saw:hello</contains>
		</expect-output>

		<expect-task task="reader" status="running" />
	</then>

	<cleanup>
		<bt-stop task="reader" mode="kill" />
	</cleanup>
</scenario>
```

## Parser

The parser should use Bun's `HTMLRewriter` to extract a restricted scenario AST instead of treating
scenario files as arbitrary HTML.

Core AST shape:

```ts
interface Scenario {
	id: string
	expected: 'pass' | 'fail' | 'skip'
	summary: string
	defaults: ScenarioDefaults
	setup: Fixture[]
	run: Operation[]
	assertions: Assertion[]
	cleanup: Operation[]
}
```

Parsing rules:

- Attribute names are kebab-case in HTML and camelCase in tool input.
  - `wait-for-idle-ms` → `waitForIdleMs`
  - `timeout-ms` → `timeoutMs`
- Numeric and boolean attributes are coerced.
- Text bodies are trimmed and dedented by default.
- Child matcher text supports quotes and multiline content.
- `<bt-start>` and executable setup fixtures contain embedded Bun JavaScript scripts, not shell
  commands.
- Avoid relying on self-closing custom tags for elements with body text.

## Script execution model

Scenarios should exercise the background-task manager, tmux panes, terminal IO, and control-channel
plumbing, but they should not spawn arbitrary programs. Executable scenario behavior is expressed as
embedded Bun scripts that the runner writes to temporary files and starts with `bun run`.

```html
<bt-start id="server" name="ready-loop">
	<script type="application/javascript">
		console.log('ready')
		await new Promise(() => undefined)
	</script>
</bt-start>
```

Rules:

- Scenario authors provide script source, not a `command` string.
- The runner materializes each script under the scenario's temporary workspace, using stable names
  derived from the scenario ID and step ID for debugging.
- The runner owns the actual `background_task` command, which should be `bun run <script-file>`.
- `application/javascript` and `text/javascript` script types are allowed; JavaScript is the default
  if the type is omitted.
- Script stdout/stderr are observed through tmux just like any real background task output.
- `<bt-send>` sends terminal input to the script's stdin, so interactive fixtures should read from
  `process.stdin` or Bun's stdin APIs.
- Long-running scripts should remain alive explicitly, for example with an unresolved promise or a
  stdin read loop. Scenario cleanup remains responsible for stopping them.
- Setup fixtures that need executable behavior should use the same embedded Bun script model. For
  example, `<tmux-task-fixture>` seeds a real tmux-backed task from its child `<script>` and writes
  scenario-controlled metadata before startup recovery runs.

This keeps scenarios declarative and JavaScript-native while still testing the real integration path.

## Operation compiler

Each `<bt-*>` tag compiles into one `background_task` input. For `<bt-start>`, the scenario script
is materialized first and the generated command points at that script.

```html
<bt-start id="server" name="ready-loop" cols="80" rows="12">
	<script type="application/javascript">
		console.log('ready')
		await new Promise(() => undefined)
	</script>
</bt-start>
```

compiles to:

```json
{
	"action": "start",
	"name": "ready-loop",
	"cols": 80,
	"rows": 12,
	"command": "bun run <scenario-temp>/lifecycle-ready/server.js"
}
```

```html
<bt-send task="reader">
	hello
	<key>Enter</key>
</bt-send>
```

compiles to:

```json
{
	"action": "send",
	"taskID": "<resolved task id for reader>",
	"text": "hello",
	"keys": ["Enter"]
}
```

Alias rules:

- Every operation `id` creates a step alias.
- Task-producing operations also create a task alias.
  - `<bt-start id="server">` creates step `server` and task `server`.
  - `<bt-wait id="ready">` creates only step `ready`.

## Scenario harness

The runner should create an in-process `BackgroundTaskManager` and send requests through the shared
`background_task` input executor.

Per scenario, the runner should:

1. Create a temporary workspace with `.amp/in/` and any minimal workspace-root files required.
2. Create a manager-backed harness in that workspace.
3. Send every operation through the shared input executor.
4. Capture structured harness logs/events in memory.
5. Always run cleanup.
6. Kill leaked tmux sessions for that scenario workspace.

Initially, scenarios should run serially because the current manager derives tmux socket names from
the process cwd and workspace root. Parallelism can come later once workspace-root handling is
isolated per subprocess or made injectable.

## Operation log

The runner should keep an in-memory operation log:

```ts
interface OperationLogEntry {
	stepID: string
	action: string
	input: Record<string, unknown>
	response: unknown
	canonical: CanonicalResponse
	startedAt: number
	durationMs: number
	error: string | null
}
```

It should also keep event logs:

```ts
interface RunnerEvent {
	type: 'harness-log' | 'notification' | 'cleanup' | 'probe'
	message: string
	data: unknown
}
```

Assertions should target either the operation log or current scenario state.

## Canonical response adapter

The canonical response adapter is the important seam. Current responses may look like:

```json
{
	"ok": true,
	"result": "{ \"action\": \"start\", ... }"
}
```

Later responses might look like:

```json
{
	"ok": true,
	"result": {
		"action": "start"
	}
}
```

Scenarios should not care. The adapter normalizes both into a stable model:

```ts
interface CanonicalResponse {
	ok: boolean
	action: string | null
	status: string | null
	message: string | null
	matched: boolean | null
	reason: string | null
	task: CanonicalTask | null
	tasks: CanonicalTask[]
	snapshot: CanonicalSnapshot | null
	notifications: unknown
	error: string | null
	raw: unknown
}
```

Common canonical fields include:

- `action`
- `status`
- `matched`
- `reason`
- `task.id`
- `task.name`
- `task.status`
- `task.dimensions.cols`
- `snapshot.screen`
- `snapshot.recentOutput`
- `snapshot.paneDead`
- `tasks`

If the plugin response format changes, update the adapter once instead of updating every scenario.

## Assertion style

Assertions should state the facts the scenario cares about directly. Avoid named bundles or hidden
rules; a reader should be able to understand the expectation from the scenario file alone.

### Semantic assertions

```html
<expect-task task="server" status="running" name="ready-loop" />

<expect-output task="server">
	<contains>ready</contains>
	<not-contains>Traceback</not-contains>
</expect-output>

<expect-notification count="1">
	<contains>matched "out:notify-me"</contains>
</expect-notification>
```

### Step response assertions

Use `<expect-step>` for facts about one operation's canonical response. Simple scalar fields can be
attributes, and nested or textual fields can use child `<field>` matchers.

```html
<expect-step step="ready" action="wait" matched="true">
	<field name="reason">
		<contains>ready</contains>
	</field>

	<field name="snapshot.screen">
		<contains>ready</contains>
	</field>
</expect-step>

<expect-step step="snapshot" action="snapshot">
	<field name="snapshot.dimensions.cols">
		<equals>80</equals>
	</field>

	<field name="snapshot.screen">
		<contains>ready</contains>
	</field>
</expect-step>
```

`field name` is a canonical field path, not raw response JSONPath.

## Matcher vocabulary

Every text matcher should work as a child element:

```html
<contains>matched "out:notify-me"</contains>
<not-contains>Traceback</not-contains>
<equals>running</equals>
<matches flags="i">error|failed|exception</matches>
<exists />
```

Default text normalization:

- Trim leading and trailing blank lines.
- Dedent common indentation.
- Preserve internal newlines.

Opt into exact whitespace only when needed:

```html
<contains whitespace="preserve"> exact leading spaces</contains>
```

## Expected pass/fail state

Scenario-level state:

```html
<scenario id="contains-notification" expected="fail" reason="notification debounce bug"></scenario>
```

Runner result semantics:

- `expected="pass"` and passes → pass
- `expected="pass"` and fails → fail
- `expected="fail"` and fails → xfail
- `expected="fail"` and passes → xpass, probably non-zero exit
- `expected="skip"` → skipped

Keep status updates separate from expectation updates:

```sh
bun run scenarios -- --update-expectations
bun run scenarios -- --update-status
```

## Updating expectations

Since the runner does not store wire transcripts, update mode should only touch explicitly managed
expected values.

```html
<expect-step step="snapshot">
	<field name="snapshot.dimensions.cols" update="auto">
		<equals>80</equals>
	</field>
</expect-step>
```

If the actual value becomes `100`, then:

```sh
bun run scenarios -- --update-expectations
```

rewrites only that managed field:

```html
<field name="snapshot.dimensions.cols" update="auto">
	<equals>100</equals>
</field>
```

Semantic matchers should not update by default:

```html
<expect-output task="server">
	<contains>ready</contains>
</expect-output>
```

That is hand-authored behavior, not a snapshot.

## CLI shape

Add a dedicated runner CLI:

```sh
bun run scenarios
bun run scenarios -- test/scenarios/interactive-send.html
bun run scenarios -- --filter notification
bun run scenarios -- --update-expectations
bun run scenarios -- --update-status
bun run scenarios -- --debug
```

Output should be scenario-focused:

```text
RUN lifecycle-ready server start name=ready-loop
RUN lifecycle-ready ready wait task=server contains=ready
CLEANUP lifecycle-ready stop-1 stop task=server mode=kill
PASS lifecycle-ready
PASS interactive-send
XFAIL contains-notification notification debounce bug
FAIL resize-and-list

resize-and-list
  expect-task task="server" status="running"
    expected: running
    actual: exited

  Last canonical response for step "resize":
    action: resize
    status: exited
    task.name: resizable-task
```

## File organization

```text
test/
  scenarios/
    lifecycle-ready.html
    interactive-send.html
    resize-and-list.html
    contains-notification.html

src/scenarios/
  cli.ts
  parser.ts
  operations.ts
  runner.ts
  canonical-response.ts
  assertions.ts
  update.ts
  reporter.ts
```

An optional Bun test wrapper can be added later so CI can run scenarios through `bun test` while
developers still have a direct scenario CLI for update and debug workflows.

## Guiding principle

The runner should not be a generic HTML test framework. It should be a tiny compiler for this
sentence:

> Given these background task operations, the operation log and current task state should satisfy
> these high-level facts.

That keeps scenario files readable and makes response-format churn a runner concern instead of a
mass test-update problem.
