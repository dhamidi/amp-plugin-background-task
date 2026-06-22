import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BackgroundTaskManager, startupReapGraceMs } from '../background-task-manager'
import { executeBackgroundTaskInput } from '../register'
import { TmuxConnection } from '../tmux/connection'
import type { PersistedTaskMetadata } from '../tmux/metadata'
import { tmuxSocketNameForWorkspace, workspaceHash } from '../workspace'
import { type AssertionDiagnostic, evaluateAssertions } from './assertions'
import {
	type CanonicalResponse,
	type CanonicalSnapshot,
	normalizeScenarioResult,
} from './canonical-response'
import { type CompiledOperation, compileOperation } from './operations'
import {
	parseScenarioFile,
	type Scenario,
	type ScenarioFixture,
	type ScenarioOperation,
} from './parser'

export interface RunScenarioOptions {
	debug: boolean
	keepTemp: boolean
	onProgress?: (event: ScenarioProgressEvent) => void
}

export interface ScenarioProgressEvent {
	scenarioID: string
	phase: OperationLogEntry['phase']
	stepID: string
	action: string
	taskAlias: string | null
	attributes: Record<string, unknown>
	text: string
	keys: string[]
	matchers: Array<{ kind: string; value: string }>
}

export interface ScenarioRunResult {
	scenario: Scenario
	status: ScenarioResultStatus
	passed: boolean
	diagnostics: AssertionDiagnostic[]
	operationErrors: AssertionDiagnostic[]
	log: OperationLogEntry[]
	events: RunnerEvent[]
	tempDir: string | null
}

export type ScenarioResultStatus = 'pass' | 'fail' | 'xfail' | 'xpass' | 'skip'

export interface OperationLogEntry {
	stepID: string
	action: string
	taskAlias: string | null
	phase: 'run' | 'cleanup' | 'auto-cleanup'
	input: Record<string, unknown>
	response: unknown
	canonical: CanonicalResponse
	startedAt: number
	durationMs: number
	error: string | null
}

export interface RunnerEvent {
	type: 'harness-log' | 'notification' | 'cleanup' | 'fixture' | 'probe'
	message: string
	data: unknown
}

export interface ScenarioRuntimeState {
	taskAliases: Map<string, string>
	tasks: Map<string, RuntimeTaskState>
	events: RunnerEvent[]
}

export interface RuntimeTaskState {
	alias: string
	id: string
	name: string | null
	status: string | null
	snapshot: CanonicalSnapshot | null
	lastStepID: string
}

interface MutableRunState extends ScenarioRuntimeState {
	steps: Map<string, OperationLogEntry>
	log: OperationLogEntry[]
}

interface FixtureCleanupTarget {
	fixtureID: string
	taskID: string
	sessionTarget: string
	backend: TmuxConnection
}

interface ScenarioHarness {
	execute(input: Record<string, unknown>): Promise<unknown>
	restart(): Promise<void>
	dispose(): void
}

const scenarioThreadID = 'T-scenario'

function createScenarioHarness(state: MutableRunState): ScenarioHarness {
	let manager = createScenarioManager(state)
	return {
		async execute(input) {
			state.events.push({
				type: 'harness-log',
				message: 'background-task input',
				data: input,
			})
			try {
				const result = await executeBackgroundTaskInput(input, {
					backgroundTaskManager: manager,
					threadID: scenarioThreadID,
				})
				state.events.push({
					type: 'harness-log',
					message: 'background-task result',
					data: result,
				})
				return result
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				state.events.push({
					type: 'harness-log',
					message: 'background-task error',
					data: { message },
				})
				throw error
			}
		},
		async restart() {
			manager.dispose()
			manager = createScenarioManager(state)
		},
		dispose() {
			manager.dispose()
		},
	}
}

function createScenarioManager(state: MutableRunState): BackgroundTaskManager {
	return new BackgroundTaskManager({
		notify: async (notification) => {
			state.events.push({
				type: 'notification',
				message: 'background-task notification',
				data: notification.content,
			})
		},
	})
}

export async function runScenarioFile(
	filePath: string,
	options: RunScenarioOptions,
): Promise<ScenarioRunResult> {
	return runScenario(await parseScenarioFile(resolve(filePath)), options)
}

export async function runScenario(
	scenario: Scenario,
	options: RunScenarioOptions,
): Promise<ScenarioRunResult> {
	const state: MutableRunState = {
		taskAliases: new Map(),
		tasks: new Map(),
		events: [],
		steps: new Map(),
		log: [],
	}
	if (scenario.expected === 'skip') {
		return resultForScenario(scenario, 'skip', [], [], state, null)
	}

	const originalCwd = process.cwd()
	const tempDir = await mkdtemp(join(tmpdir(), `background-task-${scenario.id}-`))
	const scriptRoot = join(tempDir, '.amp/scenarios/scripts')
	let harness: ScenarioHarness | null = null
	const operationErrors: AssertionDiagnostic[] = []
	const fixtureCleanupTargets: FixtureCleanupTarget[] = []

	try {
		await prepareWorkspace(tempDir)
		process.chdir(tempDir)
		harness = createScenarioHarness(state)

		for (const fixture of scenario.setup) {
			const error = await executeScenarioFixture({
				fixture,
				scenario,
				scriptRoot,
				state,
				cleanupTargets: fixtureCleanupTargets,
			})
			if (error !== null) operationErrors.push(error)
		}

		if (operationErrors.length === 0) {
			for (const operation of scenario.run) {
				const error = await executeScenarioOperation({
					operation,
					phase: 'run',
					scenario,
					harness,
					scriptRoot,
					state,
					onProgress: options.onProgress,
				})
				if (error !== null) {
					operationErrors.push(error)
					break
				}
			}
		}

		const assertionDiagnostics = evaluateAssertions({
			assertions: scenario.assertions,
			steps: state.steps,
			state,
		})

		for (const operation of scenario.cleanup) {
			const error = await executeScenarioOperation({
				operation,
				phase: 'cleanup',
				scenario,
				harness,
				scriptRoot,
				state,
				onProgress: options.onProgress,
			})
			if (error !== null)
				state.events.push({ type: 'cleanup', message: error.message, data: error })
		}

		await stopKnownRunningTasks({
			scenario,
			harness,
			scriptRoot,
			state,
			onProgress: options.onProgress,
		})
		await cleanupScenarioFixtures(fixtureCleanupTargets, state)
		return resultForScenario(
			scenario,
			resultStatus(scenario, [...operationErrors, ...assertionDiagnostics].length === 0),
			assertionDiagnostics,
			operationErrors,
			state,
			options.keepTemp ? tempDir : null,
		)
	} finally {
		harness?.dispose()
		await cleanupScenarioFixtures(fixtureCleanupTargets, state)
		process.chdir(originalCwd)
		if (!options.keepTemp) await rm(tempDir, { recursive: true, force: true })
	}
}

async function executeScenarioFixture(options: {
	fixture: ScenarioFixture
	scenario: Scenario
	scriptRoot: string
	state: MutableRunState
	cleanupTargets: FixtureCleanupTarget[]
}): Promise<AssertionDiagnostic | null> {
	try {
		if (options.fixture.type !== 'tmux-task-fixture') {
			throw new Error(`Unsupported setup fixture <${options.fixture.type}>`)
		}
		await createTmuxTaskFixture(options)
		return null
	} catch (error) {
		return operationDiagnostic(options.fixture.id ?? options.fixture.type, error)
	}
}

async function createTmuxTaskFixture(options: {
	fixture: ScenarioFixture
	scenario: Scenario
	scriptRoot: string
	state: MutableRunState
	cleanupTargets: FixtureCleanupTarget[]
}): Promise<void> {
	const fixtureID = options.fixture.id
	if (fixtureID === null) throw new Error('<tmux-task-fixture> requires id="..."')
	if (options.fixture.script === null) {
		throw new Error(`<tmux-task-fixture id="${fixtureID}"> requires an embedded <script>`)
	}

	const workspaceRoot = process.cwd()
	const hash = workspaceHash(workspaceRoot)
	const backend = new TmuxConnection(tmuxSocketNameForWorkspace(hash))
	const name = stringAttribute(options.fixture.attributes, 'name') ?? fixtureID
	const keepAlive = booleanAttribute(options.fixture.attributes, 'keepAlive') ?? false
	const lastActivityAgeMs =
		numberAttribute(options.fixture.attributes.lastActivityAgeMs) ?? startupReapGraceMs + 1_000
	const dimensions = {
		cols: numberAttribute(options.fixture.attributes.cols) ?? 120,
		rows: numberAttribute(options.fixture.attributes.rows) ?? 40,
	}
	const taskID = `bt_fixture_${sha256(`${options.scenario.id}:${fixtureID}`).slice(0, 12)}`
	const sessionName = `amp-bg-${hash}-${taskID.replace(/_/g, '-')}`
	const scriptPath = await materializeFixtureScript(
		options.fixture,
		options.scenario,
		options.scriptRoot,
	)
	const command = `bun run ${shellQuote(scriptPath)}`
	const createResult = await backend.runner.runOrThrow([
		'set-option',
		'-gq',
		'remain-on-exit',
		'on',
		';',
		'new-session',
		'-d',
		'-P',
		'-F',
		'#{session_id}\t#{window_id}\t#{pane_id}',
		'-s',
		sessionName,
		'-x',
		String(dimensions.cols),
		'-y',
		String(dimensions.rows),
		'-c',
		workspaceRoot,
		command,
	])
	const [sessionID = '', windowID = '', primaryPane = ''] = createResult.stdout.trim().split('\t')
	const lastActivityAt = Date.now() - lastActivityAgeMs
	const metadata: PersistedTaskMetadata = {
		schemaVersion: 1,
		taskID,
		workspaceHash: hash,
		owner: 'plugin',
		name,
		originThreadID: scenarioThreadID,
		startKey: `sha256:${sha256(`${options.scenario.id}:${fixtureID}:fixture`)}`,
		command,
		cwd: workspaceRoot,
		env: {},
		createdAt: lastActivityAt,
		lastActivityAt,
		keepAlive,
		sessionID,
		sessionName,
		windowID,
		primaryPane,
		dimensions,
		notifications: null,
		notificationState: { sentCount: 0, lastSentAt: null, lastTriggerKey: null },
	}
	await backend.writeMetadata(metadata)
	options.state.taskAliases.set(fixtureID, taskID)
	options.cleanupTargets.push({
		fixtureID,
		taskID,
		sessionTarget: sessionID || sessionName,
		backend,
	})
	options.state.events.push({
		type: 'fixture',
		message: `Created tmux task fixture ${fixtureID}.`,
		data: { taskID, sessionName, scriptPath },
	})
}

async function materializeFixtureScript(
	fixture: ScenarioFixture,
	scenario: Scenario,
	scriptRoot: string,
): Promise<string> {
	await mkdir(scriptRoot, { recursive: true })
	const fixtureID = fixture.id ?? 'fixture'
	const scriptPath = join(
		scriptRoot,
		`${sanitizeFileName(`${scenario.id}-${fixtureID}`)}.fixture.js`,
	)
	await writeFile(scriptPath, `${fixture.script?.source ?? ''}\n`, 'utf8')
	return scriptPath
}

async function cleanupScenarioFixtures(
	cleanupTargets: FixtureCleanupTarget[],
	state: MutableRunState,
): Promise<void> {
	while (cleanupTargets.length > 0) {
		const target = cleanupTargets.pop()
		if (target === undefined) continue
		try {
			await target.backend.killSession(target.sessionTarget)
			state.events.push({
				type: 'fixture',
				message: `Cleaned up tmux task fixture ${target.fixtureID}.`,
				data: { taskID: target.taskID },
			})
		} catch {
			state.events.push({
				type: 'fixture',
				message: `Tmux task fixture ${target.fixtureID} was already gone.`,
				data: { taskID: target.taskID },
			})
		}
	}
}

async function executeScenarioOperation(options: {
	operation: ScenarioOperation
	phase: OperationLogEntry['phase']
	scenario: Scenario
	harness: ScenarioHarness
	scriptRoot: string
	state: MutableRunState
	onProgress: RunScenarioOptions['onProgress']
}): Promise<AssertionDiagnostic | null> {
	options.onProgress?.(
		progressEventForOperation(options.scenario, options.phase, options.operation),
	)

	if (options.operation.action === 'runner-restart') {
		return executeRunnerRestart(options)
	}

	let compiled: CompiledOperation
	try {
		compiled = await compileOperation(options.operation, {
			scenarioID: options.scenario.id,
			scriptRoot: options.scriptRoot,
			defaults: options.scenario.defaults,
			taskAliases: options.state.taskAliases,
		})
	} catch (error) {
		return operationDiagnostic(options.operation.id, error)
	}

	const startedAt = Date.now()
	let response: unknown = null
	let error: Error | null = null
	try {
		response = await options.harness.execute(compiled.input)
	} catch (caught) {
		error = caught instanceof Error ? caught : new Error(String(caught))
	}

	const entry: OperationLogEntry = {
		stepID: compiled.stepID,
		action: compiled.action,
		taskAlias: taskAliasForOperation(options.operation),
		phase: options.phase,
		input: compiled.input,
		response,
		canonical: normalizeScenarioResult(response, error),
		startedAt,
		durationMs: Date.now() - startedAt,
		error: error?.message ?? null,
	}
	options.state.log.push(entry)
	options.state.steps.set(entry.stepID, entry)
	updateRuntimeTasks(options.operation, entry, options.state)

	return error === null ? null : operationDiagnostic(options.operation.id, error)
}

async function stopKnownRunningTasks(options: {
	scenario: Scenario
	harness: ScenarioHarness
	scriptRoot: string
	state: MutableRunState
	onProgress: RunScenarioOptions['onProgress']
}): Promise<void> {
	for (const task of options.state.tasks.values()) {
		if (task.status === 'stopped' || task.status === 'missing') continue
		const operation: ScenarioOperation = {
			action: 'stop',
			tagName: 'bt-stop',
			id: `auto-stop-${task.alias}`,
			taskAlias: task.alias,
			attributes: { mode: 'kill' },
			script: null,
			text: '',
			keys: [],
			matchers: [],
			notifications: null,
		}
		await executeScenarioOperation({
			operation,
			phase: 'auto-cleanup',
			scenario: options.scenario,
			harness: options.harness,
			scriptRoot: options.scriptRoot,
			state: options.state,
			onProgress: options.onProgress,
		})
	}
}

async function executeRunnerRestart(options: {
	operation: ScenarioOperation
	phase: OperationLogEntry['phase']
	state: MutableRunState
	harness: ScenarioHarness
}): Promise<AssertionDiagnostic | null> {
	const startedAt = Date.now()
	let error: Error | null = null
	try {
		await options.harness.restart()
		const waitAfterMs = numberAttribute(options.operation.attributes.waitAfterMs)
		if (waitAfterMs !== null) await sleep(waitAfterMs)
	} catch (caught) {
		error = caught instanceof Error ? caught : new Error(String(caught))
	}

	const response = {
		action: 'runner_restart',
		status: error === null ? 'ok' : 'error',
		message: error === null ? 'Restarted the background-task harness.' : error.message,
	}
	const entry: OperationLogEntry = {
		stepID: options.operation.id,
		action: options.operation.action,
		taskAlias: null,
		phase: options.phase,
		input: { action: options.operation.action, ...options.operation.attributes },
		response,
		canonical: normalizeScenarioResult(response, null),
		startedAt,
		durationMs: Date.now() - startedAt,
		error: error?.message ?? null,
	}
	options.state.log.push(entry)
	options.state.steps.set(entry.stepID, entry)

	return error === null ? null : operationDiagnostic(options.operation.id, error)
}

function progressEventForOperation(
	scenario: Scenario,
	phase: OperationLogEntry['phase'],
	operation: ScenarioOperation,
): ScenarioProgressEvent {
	return {
		scenarioID: scenario.id,
		phase,
		stepID: operation.id,
		action: operation.action,
		taskAlias: taskAliasForOperation(operation),
		attributes: operation.attributes,
		text: operation.text,
		keys: operation.keys,
		matchers: operation.matchers.map((matcher) => ({
			kind: matcher.kind,
			value: matcher.value,
		})),
	}
}

function updateRuntimeTasks(
	operation: ScenarioOperation,
	entry: OperationLogEntry,
	state: MutableRunState,
): void {
	const canonicalTask = entry.canonical.task
	const alias = taskAliasForOperation(operation)
	if (canonicalTask?.id !== null && canonicalTask?.id !== undefined && alias !== null) {
		state.taskAliases.set(alias, canonicalTask.id)
		state.tasks.set(alias, {
			alias,
			id: canonicalTask.id,
			name: canonicalTask.name,
			status: canonicalTask.status ?? entry.canonical.status,
			snapshot: entry.canonical.snapshot,
			lastStepID: entry.stepID,
		})
		return
	}

	if (operation.taskAlias === null) return
	const existing = state.tasks.get(operation.taskAlias)
	if (existing === undefined) return
	state.tasks.set(operation.taskAlias, {
		...existing,
		status: entry.canonical.status ?? existing.status,
		snapshot: entry.canonical.snapshot ?? existing.snapshot,
		lastStepID: entry.stepID,
	})
}

function taskAliasForOperation(operation: ScenarioOperation): string | null {
	if (operation.action === 'start') return operation.id
	return operation.taskAlias
}

async function prepareWorkspace(tempDir: string): Promise<void> {
	await mkdir(join(tempDir, '.amp/in'), { recursive: true })
	await writeFile(join(tempDir, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
}

function resultForScenario(
	scenario: Scenario,
	status: ScenarioResultStatus,
	diagnostics: AssertionDiagnostic[],
	operationErrors: AssertionDiagnostic[],
	state: MutableRunState,
	tempDir: string | null,
): ScenarioRunResult {
	return {
		scenario,
		status,
		passed: status === 'pass' || status === 'xfail' || status === 'skip',
		diagnostics,
		operationErrors,
		log: state.log,
		events: state.events,
		tempDir,
	}
}

function resultStatus(scenario: Scenario, passed: boolean): ScenarioResultStatus {
	if (scenario.expected === 'fail') return passed ? 'xpass' : 'xfail'
	return passed ? 'pass' : 'fail'
}

function operationDiagnostic(stepID: string, error: unknown): AssertionDiagnostic {
	return {
		message: `Operation "${stepID}" failed`,
		expected: 'successful operation',
		actual: error instanceof Error ? error.message : String(error),
		context: stepID,
	}
}

function numberAttribute(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | null {
	const value = attributes[key]
	return typeof value === 'string' ? value : null
}

function booleanAttribute(attributes: Record<string, unknown>, key: string): boolean | null {
	const value = attributes[key]
	return typeof value === 'boolean' ? value : null
}

function sanitizeFileName(value: string): string {
	return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'scenario-fixture'
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}
