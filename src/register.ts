import type {
	PluginAPI,
	PluginToolContext,
	StatusItemValue,
	Subscription,
	ThreadID,
} from '@ampcode/plugin'
import type {
	BackgroundTaskAction,
	BackgroundTaskNotification,
	BackgroundTaskNotifier,
	BackgroundTaskSummary,
	TaskStatus,
} from './background-task-manager'
import { BackgroundTaskManager } from './background-task-manager'

export const backgroundTaskActions = [
	'start',
	'send',
	'snapshot',
	'wait',
	'configure_notifications',
	'resize',
	'stop',
	'list',
] as const satisfies readonly BackgroundTaskAction[]

const supportedActions = new Set<BackgroundTaskAction>(backgroundTaskActions)
let defaultManager: BackgroundTaskManager | null = null

type ExperimentalRegistrar = Partial<
	Pick<NonNullable<PluginAPI['experimental']>, 'createStatusItem' | 'threads'>
>

type ToolRegistrar = Pick<PluginAPI, 'registerTool'> & {
	registerCommand?: PluginAPI['registerCommand']
	experimental?: ExperimentalRegistrar
}

interface BackgroundTaskStatusController extends Subscription {
	refresh(): Promise<void>
}

const statusRefreshIntervalMs = 5_000
const statusCommandID = 'background-task.list'
const statusCommandURI = `command:${statusCommandID}`

const taskStatusSortOrder: Record<TaskStatus, number> = {
	running: 0,
	exited: 1,
	missing: 2,
	stopped: 3,
}

export function registerBackgroundTaskTool(amp: ToolRegistrar): Subscription {
	const manager = createBackgroundTaskManager({ notify: createNotifier(amp) })
	const statusController = createBackgroundTaskStatusController(amp, manager)
	const subscription = amp.registerTool({
		name: 'background_task',
		description:
			'Manage interactive background terminal tasks with one action-based interface. Start commands in the background, send input, inspect snapshots, wait for conditions, list tasks, and stop them.',
		inputSchema: {
			type: 'object',
			additionalProperties: true,
			properties: {
				action: {
					type: 'string',
					enum: backgroundTaskActions,
					description:
						'Action to perform: start, send, snapshot, wait, configure_notifications, resize, stop, or list.',
				},
				taskID: {
					type: 'string',
					description: 'Logical background task ID returned by start.',
				},
				command: {
					type: 'string',
					description: 'Command to run for action=start.',
				},
				cwd: {
					type: 'string',
					description: 'Working directory for action=start. Defaults to the workspace root.',
				},
				name: {
					type: 'string',
					description: 'Human-readable task label.',
				},
				text: {
					type: 'string',
					description: 'Literal text to send for action=send.',
				},
				keys: {
					type: 'array',
					items: { type: 'string' },
					description: 'Named keys to send for action=send.',
				},
				timeoutMs: {
					type: 'number',
					description: 'Maximum time to wait for action=wait.',
				},
				contains: {
					type: 'string',
					description: 'Wait until the task snapshot contains this text.',
				},
				keepAlive: {
					type: 'boolean',
					description:
						'For action=start, preserve the tmux session across plugin reloads. ' +
						'For stop mode=detach, true marks the task keepAlive before detaching.',
				},
				mode: {
					type: 'string',
					description:
						'Stop mode: detach (requires keepAlive or keepAlive=true), interrupt, or kill.',
				},
			},
			required: ['action'],
		},
		async execute(input, ctx) {
			try {
				return await executeBackgroundTask(input, ctx, manager)
			} finally {
				void statusController.refresh()
			}
		},
	})
	return {
		unsubscribe() {
			statusController.unsubscribe()
			manager.dispose()
			subscription.unsubscribe()
		},
	}
}

export function createBackgroundTaskManager(options?: {
	notify?: BackgroundTaskNotifier
	recoverOnStartup?: boolean
}): BackgroundTaskManager {
	return new BackgroundTaskManager(options)
}

export async function executeBackgroundTask(
	input: Record<string, unknown>,
	ctx: PluginToolContext,
	backgroundTaskManager?: BackgroundTaskManager,
): Promise<string> {
	const options: BackgroundTaskInputOptions = { threadID: ctx.thread.id }
	if (backgroundTaskManager !== undefined) {
		options.backgroundTaskManager = backgroundTaskManager
	}
	return executeBackgroundTaskInput(input, options)
}

export interface BackgroundTaskInputOptions {
	threadID: string
	backgroundTaskManager?: BackgroundTaskManager
}

export async function executeBackgroundTaskInput(
	input: Record<string, unknown>,
	options: BackgroundTaskInputOptions,
): Promise<string> {
	const action = typeof input.action === 'string' ? input.action : null
	if (!action || !isBackgroundTaskAction(action)) {
		return JSON.stringify(
			{
				status: 'error',
				message: 'background_task requires a supported action.',
				supportedActions: [...supportedActions],
			},
			null,
			2,
		)
	}

	const manager = options.backgroundTaskManager ?? defaultBackgroundTaskManager()
	return JSON.stringify(
		await manager.execute(action, input, { threadID: options.threadID }),
		null,
		2,
	)
}

function defaultBackgroundTaskManager(): BackgroundTaskManager {
	defaultManager ??= new BackgroundTaskManager()
	return defaultManager
}

function isBackgroundTaskAction(action: string): action is BackgroundTaskAction {
	return supportedActions.has(action as BackgroundTaskAction)
}

function createBackgroundTaskStatusController(
	amp: ToolRegistrar,
	manager: BackgroundTaskManager,
): BackgroundTaskStatusController {
	const experimental = amp.experimental
	if (experimental?.createStatusItem === undefined) {
		return noopStatusController()
	}

	const statusItem = experimental.createStatusItem()
	let disposed = false
	let refreshInFlight: Promise<void> | null = null
	let statusURL: string | undefined

	const refresh = async (): Promise<void> => {
		if (disposed) return
		if (refreshInFlight !== null) {
			return refreshInFlight
		}

		refreshInFlight = refreshStatusItem(manager, statusItem.update, statusURL)
		try {
			await refreshInFlight
		} finally {
			refreshInFlight = null
		}
	}

	const refreshInterval = setInterval(() => {
		void refresh()
	}, statusRefreshIntervalMs)
	const commandSubscription = amp.registerCommand?.(
		statusCommandID,
		{
			title: 'show tasks',
			category: 'background task',
			description: 'Show background tasks',
		},
		async (ctx) => {
			try {
				for (;;) {
					const selectedTask = await selectBackgroundTask(ctx.ui, await manager.listTaskSummaries())
					if (selectedTask === null) return

					const action = await ctx.ui.select({
						title: `Background Task: ${compactTaskName(selectedTask)}`,
						message: formatSnapshotMessage(
							selectedTask,
							await manager.snapshotTask(selectedTask.taskID),
						),
						options: ['Kill', 'Back'],
					})
					if (action === 'Back') continue
					if (action !== 'Kill') return

					const result = await manager.killTask(selectedTask.taskID)
					await refresh()
					await ctx.ui.notify(formatKillResult(selectedTask, result))
					return
				}
			} catch (error) {
				await ctx.ui.notify(`Unable to manage background tasks: ${errorMessage(error)}`)
			}
		},
	)
	statusURL = commandSubscription === undefined ? undefined : statusCommandURI

	void refresh()

	return {
		async refresh() {
			await refresh()
		},
		unsubscribe() {
			if (disposed) return
			disposed = true
			clearInterval(refreshInterval)
			commandSubscription?.unsubscribe()
			statusItem.unsubscribe()
		},
	}
}

async function refreshStatusItem(
	manager: BackgroundTaskManager,
	update: (value: StatusItemValue) => void,
	statusURL: string | undefined,
): Promise<void> {
	let tasks: BackgroundTaskSummary[]
	try {
		tasks = await manager.listTaskSummaries()
	} catch {
		update({ text: '' })
		return
	}

	const value: StatusItemValue = { text: formatStatusBarTasks(tasks) }
	if (value.text.length > 0 && statusURL !== undefined) {
		value.url = statusURL
	}
	update(value)
}

function noopStatusController(): BackgroundTaskStatusController {
	return {
		async refresh() {},
		unsubscribe() {},
	}
}

function formatStatusBarTasks(tasks: readonly BackgroundTaskSummary[]): string {
	if (tasks.length === 0) return ''
	return `◷ ${tasks.length}`
}

async function selectBackgroundTask(
	ui: Pick<PluginAPI['ui'], 'notify' | 'select'>,
	tasks: readonly BackgroundTaskSummary[],
): Promise<BackgroundTaskSummary | null> {
	const entries = sortedTasks(tasks).map((task) => ({ label: taskSelectLabel(task), task }))
	if (entries.length === 0) {
		await ui.notify('No background tasks.')
		return null
	}

	const selectedLabel = await ui.select({
		title: 'Background Tasks',
		options: entries.map((entry) => entry.label),
	})
	return entries.find((entry) => entry.label === selectedLabel)?.task ?? null
}

function sortedTasks(tasks: readonly BackgroundTaskSummary[]): BackgroundTaskSummary[] {
	return [...tasks].sort((a, b) => {
		const statusDelta = taskStatusSortOrder[a.status] - taskStatusSortOrder[b.status]
		if (statusDelta !== 0) return statusDelta
		const nameDelta = compactTaskName(a).localeCompare(compactTaskName(b))
		if (nameDelta !== 0) return nameDelta
		return a.taskID.localeCompare(b.taskID)
	})
}

function taskSelectLabel(task: BackgroundTaskSummary): string {
	return `${compactTaskName(task)} — ${statusDescription(task)} — ${task.taskID}`
}

function formatSnapshotMessage(
	task: BackgroundTaskSummary,
	result: Record<string, unknown>,
): string {
	const snapshot = recordField(result, 'snapshot')
	if (snapshot === undefined) {
		return JSON.stringify(result, null, 2)
	}

	const screen = recordString(snapshot, 'screen') ?? ''
	const recentOutput = recordString(snapshot, 'recentOutput') ?? ''
	const body = screen.length > 0 ? screen : recentOutput
	return [
		`${compactTaskName(task)} (${task.taskID}) — ${statusDescription(task)}`,
		'',
		body.length > 0 ? body : '(No terminal output captured.)',
	].join('\n')
}

function formatKillResult(task: BackgroundTaskSummary, result: Record<string, unknown>): string {
	return recordString(result, 'message') ?? `Killed background task ${task.taskID}.`
}

function statusDescription(task: BackgroundTaskSummary): string {
	if (task.status !== 'exited') return task.status
	if (task.exitCode === null) return 'exited'
	return `exited ${task.exitCode}`
}

function compactTaskName(task: BackgroundTaskSummary): string {
	const name = compactSingleLine(task.name)
	return name.length > 0 ? name : task.taskID
}

function compactSingleLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim()
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function recordField(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const field = value[key]
	return isRecord(field) ? field : undefined
}

function recordString(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key]
	return typeof field === 'string' ? field : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createNotifier(amp: ToolRegistrar): BackgroundTaskNotifier | undefined {
	const threads = amp.experimental?.threads
	if (threads === undefined) {
		return undefined
	}
	return async (notification: BackgroundTaskNotification) => {
		await threads
			.get(notification.threadID as ThreadID)
			.appendUserMessage(
				{ type: 'user-message', content: notification.content },
				{ steer: notification.steer },
			)
	}
}
