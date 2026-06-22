export const metadataOption = '@amp.background-task.v1'
export const taskIDOption = '@amp.background-task.task-id'
export const startKeyOption = '@amp.background-task.start-key'

export interface TaskDimensions {
	cols: number
	rows: number
}

export interface NotificationPolicy {
	enabled: boolean
	threadID: string | null
	steer: boolean
	cooldownMs: number
	debounceMs: number
	maxMessages: number
	triggers: NotificationTrigger[]
}

export type NotificationTrigger =
	| { type: 'exit'; includeSnapshot: boolean }
	| { type: 'idle'; idleMs: number; afterOutput: boolean; includeSnapshot: boolean }
	| { type: 'contains'; pattern: string; regex: boolean; includeSnapshot: boolean }
	| { type: 'notContains'; pattern: string; regex: boolean; includeSnapshot: boolean }
	| { type: 'error-output'; includeSnapshot: boolean }

export interface NotificationState {
	sentCount: number
	lastSentAt: number | null
	lastTriggerKey: string | null
}

export interface PersistedTaskMetadata {
	schemaVersion: 1
	taskID: string
	workspaceHash: string
	owner: 'plugin'
	name: string
	originThreadID: string
	startKey: string | null
	command: string | null
	cwd: string | null
	env: Record<string, string>
	createdAt: number
	lastActivityAt: number
	keepAlive: boolean
	sessionID: string
	sessionName: string
	windowID: string
	primaryPane: string
	dimensions: TaskDimensions
	notifications: NotificationPolicy | null
	notificationState: NotificationState
}

export function parseTaskMetadata(value: string): PersistedTaskMetadata | null {
	try {
		const parsed = JSON.parse(value) as unknown
		if (!isRecord(parsed)) return null
		if (
			parsed.schemaVersion !== 1 ||
			typeof parsed.taskID !== 'string' ||
			typeof parsed.workspaceHash !== 'string' ||
			parsed.owner !== 'plugin' ||
			typeof parsed.sessionName !== 'string' ||
			typeof parsed.primaryPane !== 'string'
		) {
			return null
		}

		const createdAt = finiteNumberField(parsed, 'createdAt')
		if (createdAt === undefined) return null

		const metadata = parsed as unknown as PersistedTaskMetadata
		return {
			...metadata,
			createdAt,
			lastActivityAt: finiteNumberField(parsed, 'lastActivityAt') ?? createdAt,
		}
	} catch {
		return null
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumberField(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key]
	return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}
