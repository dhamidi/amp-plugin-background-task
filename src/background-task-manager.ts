import { createHash, randomBytes } from 'node:crypto'
import { TmuxConnection, type TmuxPaneState, type TmuxSession } from './tmux/connection'
import { ControlClient } from './tmux/control-client'
import {
	metadataOption,
	type NotificationPolicy,
	type NotificationTrigger,
	type PersistedTaskMetadata,
	parseTaskMetadata,
	type TaskDimensions,
} from './tmux/metadata'
import { findWorkspaceRoot, tmuxSocketNameForWorkspace, workspaceHash } from './workspace'

export type BackgroundTaskAction =
	| 'start'
	| 'send'
	| 'snapshot'
	| 'wait'
	| 'configure_notifications'
	| 'resize'
	| 'stop'
	| 'list'
export type TaskStatus = 'running' | 'exited' | 'missing' | 'stopped'
export type StartupTaskAction = 'recover-notifications' | 'leave-running' | 'reap-stale' | 'ignore'
export type StopDetachDecision = 'detach' | 'promote-to-keep-alive' | 'reject'

interface TaskRecord {
	metadata: PersistedTaskMetadata
	session: TmuxSession
	pane: TmuxPaneState | null
}

interface SnapshotResult {
	screen: string
	recentOutput: string
	truncated: boolean
	historyLines: number
	dimensions: TaskDimensions
	cursor: { row: number; col: number } | null
	currentCommand: string | null
	currentPath: string | null
	paneDead: boolean | null
	paneDeadStatus: number | null
	exitCode: number | null
	recentOutputDroppedChars: number
	recentOutputMaxChars: number
	recentOutputTruncated: boolean
	historySize: number | null
	captureCapped: boolean
	captureTruncated: boolean
}

interface RecentOutputSnapshot {
	text: string
	droppedChars: number
	maxChars: number
	truncated: boolean
}

interface RuntimeTask {
	runtimeKey: string
	client: ControlClient
	recentOutput: string
	droppedOutputChars: number
	notificationTimers: Map<string, ReturnType<typeof setTimeout>>
	notificationDelivery: Promise<void>
	exitPoll: ReturnType<typeof setInterval>
	exitReapTimer: ReturnType<typeof setTimeout> | null
	exitObserved: boolean
	exitProcessing: Promise<boolean> | null
}

export interface BackgroundTaskNotification {
	threadID: string
	content: string
	steer: boolean
}

export type BackgroundTaskNotifier = (notification: BackgroundTaskNotification) => Promise<void>

export interface BackgroundTaskSummary {
	taskID: string
	name: string
	status: TaskStatus
	owner: string
	command: string | null
	cwd: string | null
	createdAt: string
	exitCode: number | null
	dimensions: TaskDimensions
	backend: {
		kind: 'tmux'
		session: string
		sessionName: string
		pane: string
	}
}

export interface BackgroundTaskExecutionContext {
	threadID: string
}

interface BackgroundTaskManagerOptions {
	notify?: BackgroundTaskNotifier
	recoverOnStartup?: boolean
}

interface NotificationCandidate {
	reason: string
	triggerKey: string
	debounceKey: string
	includeSnapshot: boolean
}

type NotificationDeliveryStateDecision =
	| { type: 'skip' }
	| { type: 'disable'; metadata: PersistedTaskMetadata }
	| {
			type: 'deliver'
			metadata: PersistedTaskMetadata
			maxMessagesReached: boolean
	  }

type NotificationDeliveryOutcome = 'handled' | 'failed'

const defaultCols = 120
const defaultRows = 40
const defaultHistoryLines = 200
const maxHistoryLines = 2_000
const maxRecentOutputChars = 20_000
const notificationOutputChars = 4_000
const exitReapGraceMs = 5_000
export const startupReapGraceMs = 30_000
const activeControlClientKeys = new Set<string>()

/**
 * Coordinates the model-facing background_task API with durable tmux task state.
 * It owns runtime control clients, notification timers, and recovery around tmux sessions.
 */
export class BackgroundTaskManager {
	private readonly runtimeTasks = new Map<string, RuntimeTask>()
	private readonly notify: BackgroundTaskNotifier | undefined
	private readonly processStartedAt = Date.now()
	private startupRecoveryStarted = false

	constructor(options?: BackgroundTaskManagerOptions) {
		this.notify = options?.notify
		if (options?.recoverOnStartup ?? true) {
			this.startNotificationRecovery()
		}
	}

	dispose(): void {
		for (const taskID of [...this.runtimeTasks.keys()]) {
			this.disposeRuntimeTask(taskID)
		}
	}

	async execute(
		action: BackgroundTaskAction,
		input: Record<string, unknown>,
		ctx: BackgroundTaskExecutionContext,
	): Promise<Record<string, unknown>> {
		switch (action) {
			case 'start':
				return this.start(input, ctx)
			case 'send':
				return this.send(input)
			case 'snapshot':
				return this.snapshot(input)
			case 'wait':
				return this.wait(input)
			case 'configure_notifications':
				return this.configureNotifications(input)
			case 'resize':
				return this.resize(input)
			case 'stop':
				return this.stop(input)
			case 'list':
				return this.list(input)
		}
	}

	async listTaskSummaries(): Promise<BackgroundTaskSummary[]> {
		const workspaceRoot = findWorkspaceRoot()
		const hash = workspaceHash(workspaceRoot)
		const backend = new TmuxConnection(tmuxSocketNameForWorkspace(hash))
		const records = await this.activeTaskRecords(backend, hash, false)
		return records.map((record) => this.taskSummary(record))
	}

	async snapshotTask(taskID: string): Promise<Record<string, unknown>> {
		return this.snapshot({ taskID, includeSnapshot: true })
	}

	async killTask(taskID: string): Promise<Record<string, unknown>> {
		return this.stop({ taskID, mode: 'kill' })
	}

	private async start(
		input: Record<string, unknown>,
		ctx: BackgroundTaskExecutionContext,
	): Promise<Record<string, unknown>> {
		const command = requireString(input, 'command')
		const workspaceRoot = findWorkspaceRoot()
		const hash = workspaceHash(workspaceRoot)
		const backend = new TmuxConnection(tmuxSocketNameForWorkspace(hash))
		const cwd = stringField(input, 'cwd') ?? workspaceRoot
		const env = stringRecordField(input, 'env')
		const name = stringField(input, 'name') ?? command
		const dimensions = dimensionsFromInput(input)
		const keepAlive = booleanField(input, 'keepAlive') ?? false
		const allowDuplicate = booleanField(input, 'allowDuplicate') ?? false
		const startKey = `sha256:${sha256(stableJSON({ command, cwd, env, name, workspaceRoot }))}`

		if (!allowDuplicate) {
			const existing = (await this.activeTaskRecords(backend, hash, true)).find(
				(record) => record.metadata.startKey === startKey,
			)
			if (existing) {
				const runtime = this.ensureControlClient(backend, existing)
				const updated = await this.touchTaskActivity(backend, existing)
				return this.resultEnvelope('start', updated, {
					message: `Task ${existing.metadata.taskID} already exists for this start request.`,
					snapshot: await this.snapshotForRecord(backend, updated, input, runtime),
				})
			}
		}

		const taskID = allowDuplicate
			? `bt_${sha256(`${startKey}:${randomBytes(8).toString('hex')}`).slice(0, 12)}`
			: `bt_${sha256(startKey).slice(0, 12)}`
		const sessionName = `amp-bg-${hash}-${taskID.replace(/_/g, '-')}`
		const createArgs = [
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
			cwd,
		]
		for (const [key, value] of Object.entries(env)) {
			createArgs.push('-e', `${key}=${value}`)
		}
		createArgs.push(command)

		const createResult = await backend.runner.runOrThrow(createArgs)
		const [sessionID = '', windowID = '', primaryPane = ''] = createResult.stdout.trim().split('\t')
		const createdAt = Date.now()
		const metadata: PersistedTaskMetadata = {
			schemaVersion: 1,
			taskID,
			workspaceHash: hash,
			owner: 'plugin',
			name,
			originThreadID: ctx.threadID,
			startKey,
			command,
			cwd,
			env,
			createdAt,
			lastActivityAt: createdAt,
			keepAlive,
			sessionID,
			sessionName,
			windowID,
			primaryPane,
			dimensions,
			notifications: normalizeNotificationPolicy(input.notifications, ctx.threadID, true),
			notificationState: { sentCount: 0, lastSentAt: null, lastTriggerKey: null },
		}

		await backend.writeMetadata(metadata)
		const initialRecord = await this.recordFromMetadata(backend, metadata)
		const runtime = this.ensureControlClient(backend, initialRecord)
		await sleep(numberField(input, 'waitForIdleMs') ?? 100)
		const record = await this.recordFromMetadata(backend, metadata)
		return this.resultEnvelope('start', record, {
			message: `Started background task ${taskID}.`,
			snapshot: await this.snapshotForRecord(backend, record, input, runtime),
		})
	}

	private async send(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { backend, record, runtime } = await this.requireTask(input)
		const text = stringField(input, 'text')
		if (text !== undefined) {
			for (const item of textToSendItems(text)) {
				if (item.type === 'text' && item.value.length > 0) {
					await runtime.client.sendCommand([
						'send-keys',
						'-t',
						record.metadata.primaryPane,
						'-l',
						item.value,
					])
				} else if (item.type === 'key') {
					await runtime.client.sendCommand([
						'send-keys',
						'-t',
						record.metadata.primaryPane,
						item.value,
					])
				}
			}
		}

		const keys = stringArrayField(input, 'keys')
		if (keys.length > 0) {
			await runtime.client.sendCommand(['send-keys', '-t', record.metadata.primaryPane, ...keys])
		}

		await sleep(numberField(input, 'waitForIdleMs') ?? 100)
		const updated = await this.touchTaskActivity(
			backend,
			await this.recordFromMetadata(backend, record.metadata),
		)
		return this.resultEnvelope('send', updated, {
			message: `Sent input to ${record.metadata.taskID}.`,
			snapshot: await this.snapshotForRecord(backend, updated, input, runtime),
		})
	}

	private async snapshot(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { backend, record, runtime } = await this.requireTask(input)
		const snapshot = await this.snapshotForRecord(backend, record, input, runtime)
		const updated = await this.touchTaskActivity(backend, record)
		return this.resultEnvelope('snapshot', updated, {
			message: `Captured snapshot for ${record.metadata.taskID}.`,
			snapshot,
		})
	}

	private async wait(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { backend, record, runtime } = await this.requireTask(input)
		const timeoutMs = clamp(numberField(input, 'timeoutMs') ?? 5_000, 1, 60_000)
		const idleMs = numberField(input, 'idleMs')
		const contains = stringField(input, 'contains')
		const notContains = stringField(input, 'notContains')
		const wantsExited = booleanField(input, 'exited') ?? false
		const deadline = Date.now() + timeoutMs
		let lastScreen = ''
		let lastChange = Date.now()
		let latest = record

		for (;;) {
			latest = await this.recordFromMetadata(backend, record.metadata)
			const snapshot = await this.snapshotForRecord(
				backend,
				latest,
				{
					...input,
					includeSnapshot: true,
				},
				runtime,
			)
			if (!snapshot) {
				throw new Error('wait requires snapshots')
			}
			if (snapshot.screen !== lastScreen) {
				lastScreen = snapshot.screen
				lastChange = Date.now()
			}

			const matchReason = waitMatchReason({
				screen: snapshot.screen,
				status: taskStatus(latest.pane),
				contains,
				notContains,
				wantsExited,
				idleMs,
				lastChange,
			})
			if (matchReason !== null) {
				const updated = await this.touchTaskActivity(backend, latest)
				return this.resultEnvelope('wait', updated, {
					matched: true,
					reason: matchReason,
					snapshot,
				})
			}

			const remaining = deadline - Date.now()
			if (remaining <= 0) {
				const updated = await this.touchTaskActivity(backend, latest)
				return this.resultEnvelope('wait', updated, {
					matched: false,
					reason: 'timeout',
					snapshot,
				})
			}
			await sleep(Math.min(remaining, 100))
		}
	}

	private async configureNotifications(
		input: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const { backend, record } = await this.requireTask(input)
		const notifications = normalizeNotificationPolicy(
			input.notifications,
			record.metadata.originThreadID,
			false,
		)
		const metadata = withTaskActivity({
			...record.metadata,
			notifications,
		})
		await backend.writeMetadata(metadata)
		const updated = await this.recordFromMetadata(backend, metadata)
		return this.resultEnvelope('configure_notifications', updated, {
			message: `Updated notifications for ${metadata.taskID}.`,
			notifications: metadata.notifications,
		})
	}

	private async resize(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { backend, record, runtime } = await this.requireTask(input)
		const dimensions = dimensionsFromInput(input, record.metadata.dimensions)
		await runtime.client.sendCommand([
			'resize-window',
			'-t',
			record.metadata.sessionID || record.metadata.sessionName,
			'-x',
			String(dimensions.cols),
			'-y',
			String(dimensions.rows),
		])
		const metadata = withTaskActivity({ ...record.metadata, dimensions })
		await backend.writeMetadata(metadata)
		const updated = await this.recordFromMetadata(backend, metadata)
		return this.resultEnvelope('resize', updated, {
			message: `Resized ${metadata.taskID} to ${dimensions.cols}x${dimensions.rows}.`,
			snapshot: await this.snapshotForRecord(backend, updated, input, runtime),
		})
	}

	private async stop(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { backend, record, runtime } = await this.requireTask(input)
		const mode = stringField(input, 'mode') ?? 'kill'
		if (!isStopMode(mode)) {
			return {
				action: 'stop',
				taskID: record.metadata.taskID,
				status: 'error',
				message: `Unsupported stop mode ${JSON.stringify(mode)}. Use "detach", "interrupt", or "kill".`,
				task: this.taskSummary(record),
			}
		}

		if (mode === 'detach') {
			const detachDecision = stopDetachDecision(
				record.metadata,
				booleanField(input, 'keepAlive') === true,
			)
			if (detachDecision === 'reject') {
				return {
					action: 'stop',
					taskID: record.metadata.taskID,
					status: 'error',
					message:
						'Detach is only allowed for keepAlive tasks. Use mode="kill" to stop ' +
						'this task, or retry detach with keepAlive=true to preserve it.',
					task: this.taskSummary(record),
				}
			}

			const metadata = withTaskActivity({ ...record.metadata, keepAlive: true })
			await backend.writeMetadata(metadata)
			const updated = await this.recordFromMetadata(backend, metadata)
			this.disposeRuntimeTask(record.metadata.taskID)
			return this.resultEnvelope('stop', updated, {
				message:
					detachDecision === 'promote-to-keep-alive'
						? `Detached from ${record.metadata.taskID} and marked it keepAlive.`
						: `Detached from ${record.metadata.taskID}.`,
			})
		}

		if (mode === 'interrupt') {
			await runtime.client.sendCommand(['send-keys', '-t', record.metadata.primaryPane, 'C-c'])
			await sleep(numberField(input, 'graceMs') ?? 1_000)
			const updated = await this.recordFromMetadata(backend, record.metadata)
			if (taskStatus(updated.pane) !== 'running') {
				const touched = await this.touchTaskActivity(backend, updated)
				return this.resultEnvelope('stop', touched, {
					message: `Interrupted ${record.metadata.taskID}.`,
				})
			}
		}

		await backend.killSession(record.metadata.sessionID || record.metadata.sessionName)
		this.disposeRuntimeTask(record.metadata.taskID)
		return {
			action: 'stop',
			taskID: record.metadata.taskID,
			status: 'stopped',
			message: `Stopped ${record.metadata.taskID}.`,
		}
	}

	private async list(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const workspaceRoot = findWorkspaceRoot()
		const hash = workspaceHash(workspaceRoot)
		const backend = new TmuxConnection(tmuxSocketNameForWorkspace(hash))
		const records = await this.activeTaskRecords(backend, hash, false)
		return {
			action: 'list',
			status: 'ok',
			workspaceRoot,
			backend: { kind: 'tmux', socketName: backend.socketName },
			tasks: records.map((record) => this.taskSummary(record)),
			message: `Found ${records.length} background task${records.length === 1 ? '' : 's'}.`,
			includeSnapshot: booleanField(input, 'includeSnapshot') ?? false,
		}
	}

	private startNotificationRecovery(): void {
		if (this.startupRecoveryStarted) return
		this.startupRecoveryStarted = true
		void this.recoverStartupTasks().catch(() => {})
	}

	private async recoverStartupTasks(): Promise<void> {
		const workspaceRoot = findWorkspaceRoot()
		const hash = workspaceHash(workspaceRoot)
		const backend = new TmuxConnection(tmuxSocketNameForWorkspace(hash))
		const records = await this.taskRecords(backend, hash)
		for (const record of records) {
			const action = startupTaskAction({
				metadata: record.metadata,
				status: taskStatus(record.pane),
				processStartedAt: this.processStartedAt,
				staleReapGraceMs: startupReapGraceMs,
			})
			if (action === 'recover-notifications') {
				await this.recoverNotificationTask(backend, record)
			} else if (action === 'reap-stale') {
				await this.reapStartupTask(backend, record)
			}
		}
	}

	private async reapStartupTask(backend: TmuxConnection, record: TaskRecord): Promise<void> {
		await this.reapTask(backend, record)
	}

	private async recoverNotificationTask(
		backend: TmuxConnection,
		record: TaskRecord,
	): Promise<void> {
		try {
			this.ensureControlClient(backend, record)
			await this.evaluateExitTriggers(backend, record.metadata.taskID)
			if (taskStatus(record.pane) !== 'running') return
			await this.evaluateRecoveredSnapshotTriggers(backend, record)
		} catch {
			// Startup recovery is best-effort; tmux may be absent or sessions may disappear.
		}
	}

	private async evaluateRecoveredSnapshotTriggers(
		backend: TmuxConnection,
		record: TaskRecord,
	): Promise<void> {
		const policy = record.metadata.notifications
		if (!policy?.enabled || !policy.triggers.some((trigger) => trigger.type === 'contains')) return

		const screen = await this.capturePaneForRecord(backend, record, defaultHistoryLines)
		for (const candidate of recoveredContainsNotificationCandidates(policy, screen)) {
			this.scheduleNotification(backend, record, policy, candidate)
		}
	}

	private async requireTask(input: Record<string, unknown>): Promise<{
		backend: TmuxConnection
		record: TaskRecord
		runtime: RuntimeTask
	}> {
		const taskID = requireString(input, 'taskID')
		const workspaceRoot = findWorkspaceRoot()
		const hash = workspaceHash(workspaceRoot)
		const backend = new TmuxConnection(tmuxSocketNameForWorkspace(hash))
		const record = (await this.taskRecords(backend, hash)).find(
			(candidate) => candidate.metadata.taskID === taskID,
		)
		if (!record) {
			throw new Error(`Unknown background task: ${taskID}`)
		}
		const runtime = this.ensureControlClient(backend, record)
		return { backend, record, runtime }
	}

	private async taskRecords(backend: TmuxConnection, hash: string): Promise<TaskRecord[]> {
		const sessions = await backend.listSessions()
		const records: TaskRecord[] = []
		for (const session of sessions) {
			const value = await backend.showOption(session.id, metadataOption)
			const metadata = value === null ? null : parseTaskMetadata(value)
			if (!metadata || metadata.workspaceHash !== hash) continue
			records.push(await this.recordFromMetadata(backend, metadata, session))
		}
		return records
	}

	private async activeTaskRecords(
		backend: TmuxConnection,
		hash: string,
		reapExited: boolean,
	): Promise<TaskRecord[]> {
		const records = await this.taskRecords(backend, hash)
		const activeRecords: TaskRecord[] = []
		for (const record of records) {
			const status = taskStatus(record.pane)
			if (status === 'running') {
				activeRecords.push(record)
				continue
			}
			if (status !== 'exited') {
				await this.reapTask(backend, record)
				continue
			}
			if (this.runtimeTasks.has(record.metadata.taskID)) {
				await this.evaluateExitTriggers(backend, record.metadata.taskID)
			} else if (notificationRecoveryEnabled(record.metadata)) {
				await this.recoverNotificationTask(backend, record)
			} else {
				await this.reapTask(backend, record)
			}
			if (reapExited && this.runtimeTasks.get(record.metadata.taskID)?.exitObserved) {
				await this.reapTask(backend, record)
			}
		}
		return activeRecords
	}

	private async reapTask(backend: TmuxConnection, record: TaskRecord): Promise<void> {
		try {
			await backend.killSession(record.metadata.sessionID || record.metadata.sessionName)
		} catch {
			// Reaping is best-effort; tmux sessions may disappear between discovery and cleanup.
		}
		this.disposeRuntimeTask(record.metadata.taskID)
	}

	private async recordFromMetadata(
		backend: TmuxConnection,
		metadata: PersistedTaskMetadata,
		session?: TmuxSession,
	): Promise<TaskRecord> {
		return {
			metadata,
			session: session ?? { id: metadata.sessionID, name: metadata.sessionName },
			pane: await backend.getPaneState(metadata.primaryPane),
		}
	}

	private async touchTaskActivity(
		backend: TmuxConnection,
		record: TaskRecord,
	): Promise<TaskRecord> {
		const metadata = withTaskActivity(record.metadata)
		await backend.writeMetadata(metadata)
		return this.recordFromMetadata(backend, metadata, record.session)
	}

	private async snapshotForRecord(
		backend: TmuxConnection,
		record: TaskRecord,
		input: Record<string, unknown>,
		runtime?: RuntimeTask,
	): Promise<SnapshotResult | undefined> {
		const includeSnapshot = booleanField(input, 'includeSnapshot') ?? true
		if (!includeSnapshot) return undefined
		const requestedHistoryLines = numberField(input, 'historyLines') ?? defaultHistoryLines
		const historyLines = clamp(requestedHistoryLines, 0, maxHistoryLines)
		const pane = (await backend.getPaneState(record.metadata.primaryPane)) ?? record.pane
		return buildSnapshotResult({
			screen: await this.capturePaneForRecord(backend, record, historyLines, runtime),
			recentOutput: this.recentOutputSnapshotFor(record.metadata.taskID),
			pane,
			fallbackDimensions: record.metadata.dimensions,
			historyLines,
			requestedHistoryLines,
		})
	}

	private async capturePaneForRecord(
		backend: TmuxConnection,
		record: TaskRecord,
		historyLines: number,
		runtime = this.runtimeTasks.get(record.metadata.taskID),
	): Promise<string> {
		if (!runtime) return backend.capturePane(record.metadata.primaryPane, historyLines)

		const args = ['capture-pane', '-p', '-J', '-t', record.metadata.primaryPane]
		if (historyLines > 0) {
			args.push('-S', `-${historyLines}`)
		}
		return (await runtime.client.sendCommand(args)).trimEnd()
	}

	private ensureControlClient(backend: TmuxConnection, record: TaskRecord): RuntimeTask {
		const existing = this.runtimeTasks.get(record.metadata.taskID)
		if (existing) return existing

		const runtimeKey = controlClientKey(backend, record)
		if (activeControlClientKeys.has(runtimeKey)) {
			throw new Error(`Background task ${record.metadata.taskID} is already attached`)
		}
		activeControlClientKeys.add(runtimeKey)

		const client = new ControlClient({
			socketName: backend.socketName,
			target: record.metadata.sessionID || record.metadata.sessionName,
			onOutput: (_paneID, text) => {
				this.appendRecentOutput(record.metadata.taskID, text)
				void this.evaluateOutputTriggers(backend, record.metadata.taskID, text)
			},
			onExit: () => {
				this.clearRuntimeTaskTimers(record.metadata.taskID)
				this.runtimeTasks.delete(record.metadata.taskID)
				activeControlClientKeys.delete(runtimeKey)
			},
		})
		const runtime: RuntimeTask = {
			runtimeKey,
			client,
			recentOutput: '',
			droppedOutputChars: 0,
			notificationTimers: new Map(),
			notificationDelivery: Promise.resolve(),
			exitPoll: this.startExitPoll(backend, record.metadata.taskID),
			exitReapTimer: null,
			exitObserved: false,
			exitProcessing: null,
		}
		this.runtimeTasks.set(record.metadata.taskID, runtime)
		try {
			runtime.client.start()
		} catch (error) {
			this.runtimeTasks.delete(record.metadata.taskID)
			activeControlClientKeys.delete(runtimeKey)
			throw error
		}
		return runtime
	}

	private startExitPoll(backend: TmuxConnection, taskID: string): ReturnType<typeof setInterval> {
		const exitPoll = setInterval(() => {
			void this.evaluateExitTriggers(backend, taskID)
		}, 500)
		exitPoll.unref()
		return exitPoll
	}

	private appendRecentOutput(taskID: string, text: string): void {
		const runtime = this.runtimeTasks.get(taskID)
		if (!runtime) return

		runtime.recentOutput += text
		if (runtime.recentOutput.length <= maxRecentOutputChars) return

		const dropCount = runtime.recentOutput.length - maxRecentOutputChars
		runtime.recentOutput = runtime.recentOutput.slice(dropCount)
		runtime.droppedOutputChars += dropCount
	}

	private recentOutputFor(taskID: string): string {
		return this.recentOutputSnapshotFor(taskID).text
	}

	private recentOutputSnapshotFor(taskID: string): RecentOutputSnapshot {
		const runtime = this.runtimeTasks.get(taskID)
		if (!runtime) {
			return {
				text: '',
				droppedChars: 0,
				maxChars: maxRecentOutputChars,
				truncated: false,
			}
		}

		const text = runtime.recentOutput.trimEnd()
		return {
			text:
				runtime.droppedOutputChars === 0
					? text
					: `[dropped ${runtime.droppedOutputChars} chars]\n${text}`,
			droppedChars: runtime.droppedOutputChars,
			maxChars: maxRecentOutputChars,
			truncated: runtime.droppedOutputChars > 0,
		}
	}

	private disposeRuntimeTask(taskID: string): void {
		const runtime = this.runtimeTasks.get(taskID)
		if (!runtime) return
		this.clearRuntimeTaskTimers(taskID)
		this.runtimeTasks.delete(taskID)
		activeControlClientKeys.delete(runtime.runtimeKey)
		runtime.client.dispose()
	}

	private clearRuntimeTaskTimers(taskID: string): void {
		const runtime = this.runtimeTasks.get(taskID)
		if (!runtime) return
		clearInterval(runtime.exitPoll)
		if (runtime.exitReapTimer) clearTimeout(runtime.exitReapTimer)
		for (const timer of runtime.notificationTimers.values()) {
			clearTimeout(timer)
		}
	}

	private async evaluateOutputTriggers(
		backend: TmuxConnection,
		taskID: string,
		text: string,
	): Promise<void> {
		const record = await this.findRecordByTaskID(backend, taskID)
		if (!record?.metadata.notifications?.enabled) return

		const policy = record.metadata.notifications
		const recentOutput = this.recentOutputFor(taskID)
		for (const trigger of policy.triggers) {
			if (trigger.type === 'idle') {
				this.scheduleIdleNotification(backend, record, policy, trigger, recentOutput)
				continue
			}

			const candidate = outputNotificationCandidate(trigger, recentOutput, text)
			if (candidate) {
				this.scheduleNotification(backend, record, policy, candidate)
			}
		}
	}

	private async evaluateExitTriggers(backend: TmuxConnection, taskID: string): Promise<void> {
		const runtime = this.runtimeTasks.get(taskID)
		if (!runtime) return
		if (runtime.exitProcessing) {
			await runtime.exitProcessing
			return
		}
		if (runtime.exitObserved) return

		const record = await this.findRecordByTaskID(backend, taskID)
		if (!record?.pane?.paneDead) return
		if (runtime.exitProcessing) {
			await runtime.exitProcessing
			return
		}
		if (runtime.exitObserved) return

		runtime.exitObserved = true
		clearInterval(runtime.exitPoll)
		const exitProcessing = runtime.notificationDelivery
			.catch(() => {})
			.then(() => this.processTaskExit(backend, record))
		runtime.exitProcessing = exitProcessing
		runtime.notificationDelivery = exitProcessing.then(() => undefined)
		const handled = await exitProcessing
		if (!handled && this.runtimeTasks.get(taskID) === runtime) {
			runtime.exitObserved = false
			runtime.exitProcessing = null
			runtime.exitPoll = this.startExitPoll(backend, taskID)
		}
	}

	private async processTaskExit(backend: TmuxConnection, record: TaskRecord): Promise<boolean> {
		const policy = record.metadata.notifications
		if (policy?.enabled) {
			for (const trigger of policy.triggers) {
				if (trigger.type !== 'exit') continue
				const outcome = await this.deliverNotification(backend, record.metadata.taskID, {
					reason: `process exited with status ${record.pane?.paneDeadStatus ?? 'unknown'}`,
					triggerKey: `exit:${record.pane?.paneDeadStatus ?? 'unknown'}`,
					debounceKey: 'exit',
					includeSnapshot: trigger.includeSnapshot,
				})
				if (outcome === 'failed') return false
			}
		}
		this.scheduleExitedTaskReap(backend, record)
		return true
	}

	private scheduleExitedTaskReap(backend: TmuxConnection, record: TaskRecord): void {
		const runtime = this.runtimeTasks.get(record.metadata.taskID)
		if (!runtime || runtime.exitReapTimer) return
		runtime.exitReapTimer = setTimeout(() => {
			runtime.exitReapTimer = null
			void this.reapTask(backend, record)
		}, exitReapGraceMs)
		runtime.exitReapTimer.unref()
	}

	private scheduleIdleNotification(
		backend: TmuxConnection,
		record: TaskRecord,
		policy: NotificationPolicy,
		trigger: Extract<NotificationTrigger, { type: 'idle' }>,
		recentOutput: string,
	): void {
		const runtime = this.runtimeTasks.get(record.metadata.taskID)
		if (!runtime) return
		if (trigger.afterOutput && recentOutput.length === 0) return

		const debounceKey = idleTriggerID(trigger)
		const existing = runtime.notificationTimers.get(debounceKey)
		if (existing) clearTimeout(existing)

		const timer = setTimeout(() => {
			runtime.notificationTimers.delete(debounceKey)
			this.scheduleNotification(backend, record, policy, {
				reason: `terminal idle for ${trigger.idleMs}ms`,
				triggerKey: idleNotificationTriggerKey(
					trigger,
					this.recentOutputFor(record.metadata.taskID),
				),
				debounceKey,
				includeSnapshot: trigger.includeSnapshot,
			})
		}, trigger.idleMs)
		timer.unref()
		runtime.notificationTimers.set(debounceKey, timer)
	}

	private scheduleNotification(
		backend: TmuxConnection,
		record: TaskRecord,
		policy: NotificationPolicy,
		candidate: NotificationCandidate,
	): void {
		const runtime = this.runtimeTasks.get(record.metadata.taskID)
		if (!runtime) return

		const existing = runtime.notificationTimers.get(candidate.debounceKey)
		if (existing) clearTimeout(existing)

		const deliver = (): void => {
			runtime.notificationTimers.delete(candidate.debounceKey)
			runtime.notificationDelivery = runtime.notificationDelivery
				.catch(() => {})
				.then(async () => {
					await this.deliverNotification(backend, record.metadata.taskID, candidate)
				})
				.catch(() => {})
		}

		if (policy.debounceMs <= 0) {
			deliver()
			return
		}

		const timer = setTimeout(deliver, policy.debounceMs)
		timer.unref()
		runtime.notificationTimers.set(candidate.debounceKey, timer)
	}

	private async deliverNotification(
		backend: TmuxConnection,
		taskID: string,
		candidate: NotificationCandidate,
	): Promise<NotificationDeliveryOutcome> {
		if (this.notify === undefined) return 'handled'

		try {
			const record = await this.findRecordByTaskID(backend, taskID)
			if (!record?.metadata.notifications?.enabled) return 'handled'

			const policy = record.metadata.notifications
			const decision = notificationDeliveryStateDecision(record.metadata, candidate, Date.now())
			if (decision.type === 'skip') return 'handled'
			if (decision.type === 'disable') {
				await backend.writeMetadata(decision.metadata)
				return 'handled'
			}

			const snapshot = candidate.includeSnapshot
				? await this.snapshotForRecord(backend, record, { includeSnapshot: true })
				: undefined
			await this.notify({
				threadID: policy.threadID ?? record.metadata.originThreadID,
				content: formatNotificationMessage(record, candidate, snapshot, {
					maxMessagesReached: decision.maxMessagesReached,
					maxMessages: policy.maxMessages,
				}),
				steer: policy.steer,
			})
			await backend.writeMetadata(decision.metadata)
			return 'handled'
		} catch {
			return 'failed'
		}
	}

	private async findRecordByTaskID(
		backend: TmuxConnection,
		taskID: string,
	): Promise<TaskRecord | null> {
		const workspaceRoot = findWorkspaceRoot()
		const hash = workspaceHash(workspaceRoot)
		return (
			(await this.taskRecords(backend, hash)).find(
				(candidate) => candidate.metadata.taskID === taskID,
			) ?? null
		)
	}

	private resultEnvelope(
		action: BackgroundTaskAction,
		record: TaskRecord,
		extra: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			action,
			taskID: record.metadata.taskID,
			status: taskStatus(record.pane),
			...extra,
			task: this.taskSummary(record),
		}
	}

	private taskSummary(record: TaskRecord): BackgroundTaskSummary {
		const pane = record.pane
		return {
			taskID: record.metadata.taskID,
			name: record.metadata.name,
			status: taskStatus(pane),
			owner: record.metadata.owner,
			command: record.metadata.command,
			cwd: record.metadata.cwd,
			createdAt: new Date(record.metadata.createdAt).toISOString(),
			exitCode: pane?.paneDeadStatus ?? null,
			dimensions: pane ? { cols: pane.cols, rows: pane.rows } : record.metadata.dimensions,
			backend: {
				kind: 'tmux',
				session: record.metadata.sessionID,
				sessionName: record.metadata.sessionName,
				pane: record.metadata.primaryPane,
			},
		}
	}
}

function controlClientKey(backend: TmuxConnection, record: TaskRecord): string {
	return `${backend.socketName}:${record.metadata.taskID}`
}

interface BuildSnapshotResultOptions {
	screen: string
	recentOutput: RecentOutputSnapshot
	pane: TmuxPaneState | null
	fallbackDimensions: TaskDimensions
	historyLines: number
	requestedHistoryLines: number
}

function buildSnapshotResult(options: BuildSnapshotResultOptions): SnapshotResult {
	const historySize = options.pane?.historySize ?? null
	const captureTruncated = historySize !== null && historySize > options.historyLines
	return {
		screen: options.screen,
		recentOutput: options.recentOutput.text,
		truncated: captureTruncated,
		historyLines: options.historyLines,
		dimensions: options.pane
			? { cols: options.pane.cols, rows: options.pane.rows }
			: options.fallbackDimensions,
		cursor: options.pane?.cursor ?? null,
		currentCommand: nonEmptyString(options.pane?.currentCommand),
		currentPath: nonEmptyString(options.pane?.currentPath),
		paneDead: options.pane?.paneDead ?? null,
		paneDeadStatus: options.pane?.paneDeadStatus ?? null,
		exitCode: options.pane?.paneDeadStatus ?? null,
		recentOutputDroppedChars: options.recentOutput.droppedChars,
		recentOutputMaxChars: options.recentOutput.maxChars,
		recentOutputTruncated: options.recentOutput.truncated,
		historySize,
		captureCapped: options.historyLines !== options.requestedHistoryLines,
		captureTruncated,
	}
}

function nonEmptyString(value: string | undefined): string | null {
	return value === undefined || value.length === 0 ? null : value
}

function taskStatus(pane: TmuxPaneState | null): TaskStatus {
	if (!pane) return 'missing'
	return pane.paneDead ? 'exited' : 'running'
}

function withTaskActivity(
	metadata: PersistedTaskMetadata,
	now = Date.now(),
): PersistedTaskMetadata {
	return { ...metadata, lastActivityAt: now }
}

function requireString(input: Record<string, unknown>, key: string): string {
	const value = stringField(input, key)
	if (value === undefined || value.length === 0) {
		throw new Error(`${key} is required`)
	}
	return value
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key]
	return typeof value === 'string' ? value : undefined
}

function numberField(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key]
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanField(input: Record<string, unknown>, key: string): boolean | undefined {
	const value = input[key]
	return typeof value === 'boolean' ? value : undefined
}

function stringArrayField(input: Record<string, unknown>, key: string): string[] {
	const value = input[key]
	if (typeof value === 'string') return [value]
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function stringRecordField(input: Record<string, unknown>, key: string): Record<string, string> {
	const value = input[key]
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
	const output: Record<string, string> = {}
	for (const [entryKey, entryValue] of Object.entries(value)) {
		if (typeof entryValue === 'string') {
			output[entryKey] = entryValue
		}
	}
	return output
}

function dimensionsFromInput(
	input: Record<string, unknown>,
	fallback: TaskDimensions = { cols: defaultCols, rows: defaultRows },
): TaskDimensions {
	return {
		cols: clamp(numberField(input, 'cols') ?? fallback.cols, 20, 1_000),
		rows: clamp(numberField(input, 'rows') ?? fallback.rows, 5, 1_000),
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(value)))
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

function stableJSON(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJSON).join(',')}]`
	}
	if (typeof value === 'object' && value !== null) {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJSON(entryValue)}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}

function textToSendItems(text: string): Array<{ type: 'text' | 'key'; value: string }> {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
	const parts = normalized.split('\n')
	const items: Array<{ type: 'text' | 'key'; value: string }> = []
	for (const [index, part] of parts.entries()) {
		if (part.length > 0) items.push({ type: 'text', value: part })
		if (index < parts.length - 1) items.push({ type: 'key', value: 'Enter' })
	}
	return items
}

function isStopMode(mode: string): mode is 'detach' | 'interrupt' | 'kill' {
	return mode === 'detach' || mode === 'interrupt' || mode === 'kill'
}

function waitMatchReason(options: {
	screen: string
	status: TaskStatus
	contains: string | undefined
	notContains: string | undefined
	wantsExited: boolean
	idleMs: number | undefined
	lastChange: number
}): string | null {
	if (options.contains !== undefined && options.screen.includes(options.contains)) {
		return `matched ${JSON.stringify(options.contains)}`
	}
	if (options.notContains !== undefined && !options.screen.includes(options.notContains)) {
		return `no longer contains ${JSON.stringify(options.notContains)}`
	}
	if (options.wantsExited && options.status === 'exited') {
		return 'task exited'
	}
	if (options.idleMs !== undefined && Date.now() - options.lastChange >= options.idleMs) {
		return `idle for ${options.idleMs}ms`
	}
	return null
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return
	await new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeNotificationPolicy(
	value: unknown,
	defaultThreadID: string,
	useDefaultExit: boolean,
): NotificationPolicy | null {
	if (value === undefined || value === null) {
		return useDefaultExit
			? {
					enabled: true,
					threadID: defaultThreadID,
					steer: true,
					cooldownMs: 1_000,
					debounceMs: 0,
					maxMessages: 1,
					triggers: [{ type: 'exit', includeSnapshot: true }],
				}
			: null
	}

	if (!isRecord(value)) return null
	const maxMessages = clamp(recordNumber(value, 'maxMessages') ?? 5, 0, 1_000)
	const enabled = (recordBoolean(value, 'enabled') ?? true) && maxMessages > 0
	const triggers = normalizeTriggers(value.triggers)
	return {
		enabled,
		threadID: recordString(value, 'threadID') ?? defaultThreadID,
		steer: recordBoolean(value, 'steer') ?? true,
		cooldownMs: clamp(recordNumber(value, 'cooldownMs') ?? 5_000, 0, 3_600_000),
		debounceMs: clamp(recordNumber(value, 'debounceMs') ?? 500, 0, 60_000),
		maxMessages,
		triggers,
	}
}

function normalizeTriggers(value: unknown): NotificationTrigger[] {
	if (!Array.isArray(value)) return []
	return value.flatMap((entry): NotificationTrigger[] => {
		if (!isRecord(entry) || typeof entry.type !== 'string') return []
		const includeSnapshot = recordBoolean(entry, 'includeSnapshot') ?? true
		switch (entry.type) {
			case 'exit':
				return [{ type: 'exit', includeSnapshot }]
			case 'idle': {
				const idleMs = recordNumber(entry, 'idleMs')
				if (idleMs === undefined) return []
				return [
					{
						type: 'idle',
						idleMs: clamp(idleMs, 1, 3_600_000),
						afterOutput: recordBoolean(entry, 'afterOutput') ?? true,
						includeSnapshot,
					},
				]
			}
			case 'contains': {
				const pattern = recordString(entry, 'pattern')
				if (pattern === undefined) return []
				return [
					{
						type: 'contains',
						pattern,
						regex: recordBoolean(entry, 'regex') ?? false,
						includeSnapshot,
					},
				]
			}
			case 'notContains': {
				const pattern = recordString(entry, 'pattern')
				if (pattern === undefined) return []
				return [
					{
						type: 'notContains',
						pattern,
						regex: recordBoolean(entry, 'regex') ?? false,
						includeSnapshot,
					},
				]
			}
			case 'error-output':
				return [{ type: 'error-output', includeSnapshot }]
			default:
				return []
		}
	})
}

function startupTaskAction(options: {
	metadata: Pick<
		PersistedTaskMetadata,
		'createdAt' | 'lastActivityAt' | 'keepAlive' | 'notifications'
	>
	status: TaskStatus
	processStartedAt: number
	staleReapGraceMs: number
}): StartupTaskAction {
	if (options.status === 'missing' || options.status === 'stopped') return 'ignore'
	if (notificationRecoveryEnabled(options.metadata)) return 'recover-notifications'
	if (options.status === 'exited') return 'reap-stale'
	if (options.metadata.keepAlive) return 'leave-running'
	return taskActivityPredatesProcess(
		options.metadata,
		options.processStartedAt,
		options.staleReapGraceMs,
	)
		? 'reap-stale'
		: 'leave-running'
}

function notificationRecoveryEnabled(
	metadata: Pick<PersistedTaskMetadata, 'notifications'>,
): boolean {
	return metadata.notifications?.enabled === true && metadata.notifications.triggers.length > 0
}

function taskActivityPredatesProcess(
	metadata: Pick<PersistedTaskMetadata, 'createdAt' | 'lastActivityAt'>,
	processStartedAt: number,
	graceMs: number,
): boolean {
	const activityAt = Number.isFinite(metadata.lastActivityAt)
		? metadata.lastActivityAt
		: metadata.createdAt
	return activityAt < processStartedAt - graceMs
}

function stopDetachDecision(
	metadata: Pick<PersistedTaskMetadata, 'keepAlive'>,
	requestedKeepAlive: boolean,
): StopDetachDecision {
	if (metadata.keepAlive) return 'detach'
	return requestedKeepAlive ? 'promote-to-keep-alive' : 'reject'
}

function outputNotificationCandidate(
	trigger: NotificationTrigger,
	recentOutput: string,
	text: string,
): NotificationCandidate | null {
	switch (trigger.type) {
		case 'contains':
			return containsNotificationCandidate(trigger, recentOutput)
		case 'notContains':
			return notContainsNotificationCandidate(trigger, recentOutput)
		case 'error-output':
			return errorOutputNotificationCandidate(trigger, recentOutput, text)
		case 'idle':
		case 'exit':
			return null
	}
}

function containsNotificationCandidate(
	trigger: Extract<NotificationTrigger, { type: 'contains' }>,
	value: string,
): NotificationCandidate | null {
	const match = patternMatchSummary(value, trigger.pattern, trigger.regex)
	if (!match) return null

	const triggerID = patternTriggerID('contains', trigger)
	return {
		reason: `matched ${JSON.stringify(trigger.pattern)}`,
		triggerKey: `${triggerID}:${match.count}:${sha256(match.lastMatch).slice(0, 12)}`,
		debounceKey: triggerID,
		includeSnapshot: trigger.includeSnapshot,
	}
}

function notContainsNotificationCandidate(
	trigger: Extract<NotificationTrigger, { type: 'notContains' }>,
	value: string,
): NotificationCandidate | null {
	if (patternMatchSummary(value, trigger.pattern, trigger.regex)) return null

	const triggerID = patternTriggerID('notContains', trigger)
	return {
		reason: `no longer contains ${JSON.stringify(trigger.pattern)}`,
		triggerKey: `${triggerID}:absent:${outputStateFingerprint(value)}`,
		debounceKey: triggerID,
		includeSnapshot: trigger.includeSnapshot,
	}
}

function errorOutputNotificationCandidate(
	trigger: Extract<NotificationTrigger, { type: 'error-output' }>,
	recentOutput: string,
	text: string,
): NotificationCandidate | null {
	if (!errorOutputPatternMatches(text)) return null

	const match = errorOutputMatchSummary(recentOutput) ?? errorOutputMatchSummary(text)
	if (!match) return null

	return {
		reason: 'matched error-looking output',
		triggerKey: `error-output:${match.count}:${sha256(match.lastMatch).slice(0, 12)}`,
		debounceKey: 'error-output',
		includeSnapshot: trigger.includeSnapshot,
	}
}

function recoveredContainsNotificationCandidates(
	policy: NotificationPolicy,
	screen: string,
): NotificationCandidate[] {
	const candidates: NotificationCandidate[] = []
	for (const trigger of policy.triggers) {
		if (trigger.type !== 'contains') continue
		const candidate = containsNotificationCandidate(trigger, screen)
		if (candidate) candidates.push(candidate)
	}
	return candidates
}

function notificationDeliveryStateDecision(
	metadata: PersistedTaskMetadata,
	candidate: Pick<NotificationCandidate, 'triggerKey'>,
	now: number,
): NotificationDeliveryStateDecision {
	const policy = metadata.notifications
	if (!policy?.enabled) return { type: 'skip' }

	const state = metadata.notificationState
	if (state.sentCount >= policy.maxMessages) {
		return { type: 'disable', metadata: disableNotifications(metadata) }
	}
	if (state.lastTriggerKey === candidate.triggerKey) return { type: 'skip' }
	if (state.lastSentAt !== null && now - state.lastSentAt < policy.cooldownMs) {
		return { type: 'skip' }
	}

	const sentCount = state.sentCount + 1
	const maxMessagesReached = sentCount >= policy.maxMessages
	return {
		type: 'deliver',
		metadata: {
			...metadata,
			notifications: maxMessagesReached ? { ...policy, enabled: false } : policy,
			notificationState: {
				sentCount,
				lastSentAt: now,
				lastTriggerKey: candidate.triggerKey,
			},
		},
		maxMessagesReached,
	}
}

function disableNotifications(metadata: PersistedTaskMetadata): PersistedTaskMetadata {
	const policy = metadata.notifications
	if (!policy) return metadata
	return { ...metadata, notifications: { ...policy, enabled: false } }
}

interface FormatNotificationMessageOptions {
	maxMessagesReached: boolean
	maxMessages: number
}

function formatNotificationMessage(
	record: TaskRecord,
	candidate: NotificationCandidate,
	snapshot: SnapshotResult | undefined,
	options: FormatNotificationMessageOptions,
): string {
	const parts = [`Background task ${record.metadata.taskID}: ${candidate.reason}.`]
	const recentOutput = snapshot?.recentOutput || ''
	if (recentOutput.length > 0) {
		parts.push(
			`Recent output:\n${tailText(compactBlankLines(recentOutput), notificationOutputChars)}`,
		)
	}
	if (snapshot?.screen && snapshot.screen !== recentOutput) {
		parts.push(
			`Snapshot:\n${tailText(compactBlankLines(snapshot.screen), notificationOutputChars)}`,
		)
	}
	if (options.maxMessagesReached) {
		parts.push(
			`Notifications are now disabled because maxMessages (${options.maxMessages}) was reached.`,
		)
	}
	if (candidate.debounceKey !== 'exit') {
		parts.push(
			`Use background_task with action="snapshot" and taskID="${record.metadata.taskID}" ` +
				'for more detail.',
		)
	}
	return parts.join('\n\n')
}

interface PatternMatchSummary {
	count: number
	lastMatch: string
}

function patternMatchSummary(
	value: string,
	pattern: string,
	regex: boolean,
): PatternMatchSummary | null {
	if (!regex) return literalPatternMatchSummary(value, pattern)
	try {
		return regexPatternMatchSummary(value, new RegExp(pattern, 'g'))
	} catch {
		return null
	}
}

function literalPatternMatchSummary(value: string, pattern: string): PatternMatchSummary | null {
	if (pattern.length === 0) return { count: 1, lastMatch: '' }

	let count = 0
	let index = 0
	for (;;) {
		const matchIndex = value.indexOf(pattern, index)
		if (matchIndex === -1) break
		count++
		index = matchIndex + pattern.length
	}
	return count === 0 ? null : { count, lastMatch: pattern }
}

function regexPatternMatchSummary(value: string, expression: RegExp): PatternMatchSummary | null {
	const flags = expression.flags.includes('g') ? expression.flags : `${expression.flags}g`
	const regex = new RegExp(expression.source, flags)
	let count = 0
	let lastMatch = ''
	for (;;) {
		const match = regex.exec(value)
		if (!match) break
		count++
		lastMatch = match[0]
		if (match[0].length === 0) regex.lastIndex++
	}
	return count === 0 ? null : { count, lastMatch }
}

function patternTriggerID(
	type: 'contains' | 'notContains',
	trigger: Extract<NotificationTrigger, { type: 'contains' | 'notContains' }>,
): string {
	return `${type}:${trigger.regex ? 'regex' : 'text'}:${trigger.pattern}`
}

function idleTriggerID(trigger: Extract<NotificationTrigger, { type: 'idle' }>): string {
	return `idle:${trigger.idleMs}:${trigger.afterOutput ? 'after-output' : 'any-output'}`
}

function idleNotificationTriggerKey(
	trigger: Extract<NotificationTrigger, { type: 'idle' }>,
	recentOutput: string,
): string {
	return `${idleTriggerID(trigger)}:${outputStateFingerprint(recentOutput)}`
}

function outputStateFingerprint(value: string): string {
	return sha256(compactBlankLines(value).trimEnd()).slice(0, 12)
}

function errorOutputPatternMatches(value: string): boolean {
	return /\b(error|exception|failed|failure|traceback)\b/i.test(value)
}

function errorOutputMatchSummary(value: string): PatternMatchSummary | null {
	const match = regexPatternMatchSummary(value, /\b(error|exception|failed|failure|traceback)\b/gi)
	if (!match) return null

	return { count: match.count, lastMatch: lastErrorOutputLine(value) ?? match.lastMatch }
}

function lastErrorOutputLine(value: string): string | null {
	const lines = value.split('\n')
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]
		if (line !== undefined && errorOutputPatternMatches(line)) return line
	}
	return null
}

function tailText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value
	return `[truncated ${value.length - maxChars} chars]\n${value.slice(-maxChars)}`
}

function compactBlankLines(value: string): string {
	const lines = value.split('\n')
	const compacted: string[] = []
	let blankCount = 0
	for (const line of lines) {
		if (line.trim().length === 0) {
			blankCount++
			if (blankCount <= 2) compacted.push(line)
			continue
		}
		blankCount = 0
		compacted.push(line)
	}
	return compacted.join('\n')
}

export const __testing = {
	buildSnapshotResult,
	formatNotificationMessage,
	normalizeNotificationPolicy,
	notificationDeliveryStateDecision,
	notificationRecoveryEnabled,
	outputNotificationCandidate,
	recoveredContainsNotificationCandidates,
	startupTaskAction,
	stopDetachDecision,
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordString(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key]
	return typeof field === 'string' ? field : undefined
}

function recordNumber(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key]
	return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function recordBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
	const field = value[key]
	return typeof field === 'boolean' ? field : undefined
}
