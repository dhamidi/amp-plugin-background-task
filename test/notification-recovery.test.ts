import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { __testing } from '../src/background-task-manager'
import {
	type NotificationPolicy,
	type PersistedTaskMetadata,
	parseTaskMetadata,
} from '../src/tmux/metadata'

type LifecycleMetadata = Pick<
	PersistedTaskMetadata,
	'createdAt' | 'lastActivityAt' | 'keepAlive' | 'notifications'
>

describe('notification recovery helpers', () => {
	it('selects tasks with enabled notifications for recovery', () => {
		expect(
			__testing.notificationRecoveryEnabled({
				notifications: policy({ enabled: true }),
			}),
		).toBe(true)
		expect(
			__testing.notificationRecoveryEnabled({
				notifications: policy({ enabled: false }),
			}),
		).toBe(false)
		expect(
			__testing.notificationRecoveryEnabled({
				notifications: policy({ enabled: true, triggers: [] }),
			}),
		).toBe(false)
		expect(__testing.notificationRecoveryEnabled({ notifications: null })).toBe(false)
	})

	it('chooses conservative startup lifecycle actions', () => {
		const processStartedAt = 10_000
		const staleReapGraceMs = 500

		expect(
			__testing.startupTaskAction({
				metadata: lifecycle({
					keepAlive: true,
					notifications: policy({ enabled: true }),
				}),
				status: 'running',
				processStartedAt,
				staleReapGraceMs,
			}),
		).toBe('recover-notifications')
		expect(
			__testing.startupTaskAction({
				metadata: lifecycle({
					keepAlive: true,
					notifications: policy({ enabled: false }),
				}),
				status: 'running',
				processStartedAt,
				staleReapGraceMs,
			}),
		).toBe('leave-running')
		expect(
			__testing.startupTaskAction({
				metadata: lifecycle({
					keepAlive: false,
					notifications: policy({ enabled: true }),
					lastActivityAt: 1_000,
				}),
				status: 'running',
				processStartedAt,
				staleReapGraceMs,
			}),
		).toBe('recover-notifications')
		expect(
			__testing.startupTaskAction({
				metadata: lifecycle({ keepAlive: false, lastActivityAt: 9_501 }),
				status: 'running',
				processStartedAt,
				staleReapGraceMs,
			}),
		).toBe('leave-running')
		expect(
			__testing.startupTaskAction({
				metadata: lifecycle({ keepAlive: false, lastActivityAt: 1_000 }),
				status: 'exited',
				processStartedAt,
				staleReapGraceMs,
			}),
		).toBe('reap-stale')
		expect(
			__testing.startupTaskAction({
				metadata: lifecycle({ keepAlive: false, lastActivityAt: 1_000 }),
				status: 'missing',
				processStartedAt,
				staleReapGraceMs,
			}),
		).toBe('ignore')
		expect(
			__testing.startupTaskAction({
				metadata: lifecycle({ keepAlive: false, lastActivityAt: 1_000 }),
				status: 'stopped',
				processStartedAt,
				staleReapGraceMs,
			}),
		).toBe('ignore')
	})

	it('requires keepAlive intent before detaching', () => {
		expect(__testing.stopDetachDecision({ keepAlive: true }, false)).toBe('detach')
		expect(__testing.stopDetachDecision({ keepAlive: false }, true)).toBe('promote-to-keep-alive')
		expect(__testing.stopDetachDecision({ keepAlive: false }, false)).toBe('reject')
	})

	it('creates contains candidates from recovered pane snapshots', () => {
		expect(
			__testing.recoveredContainsNotificationCandidates(
				policy({
					triggers: [
						{
							type: 'contains',
							pattern: 'server ready',
							regex: false,
							includeSnapshot: true,
						},
						{
							type: 'contains',
							pattern: 'missing',
							regex: false,
							includeSnapshot: true,
						},
						{ type: 'exit', includeSnapshot: true },
					],
				}),
				'previous output\nserver ready\n',
			),
		).toEqual([
			{
				reason: 'matched "server ready"',
				triggerKey: `contains:text:server ready:1:${sha256('server ready').slice(0, 12)}`,
				debounceKey: 'contains:text:server ready',
				includeSnapshot: true,
			},
		])
	})

	it('normalizes maxMessages zero as disabled notifications', () => {
		expect(
			__testing.normalizeNotificationPolicy(
				{
					enabled: true,
					maxMessages: 0,
					triggers: [{ type: 'exit', includeSnapshot: true }],
				},
				'T-test',
				false,
			),
		).toEqual({
			enabled: false,
			threadID: 'T-test',
			steer: true,
			cooldownMs: 5_000,
			debounceMs: 500,
			maxMessages: 0,
			triggers: [{ type: 'exit', includeSnapshot: true }],
		})
	})

	it('keeps contains dedupe keys stable until a new occurrence appears', () => {
		const first = containsCandidate('server ready\n')
		const sameOccurrence = containsCandidate('server ready\nstill running\n')
		const nextOccurrence = containsCandidate('server ready\nstill running\nserver ready\n')

		if (!first || !sameOccurrence || !nextOccurrence) {
			throw new Error('Expected contains candidates')
		}
		expect(sameOccurrence.triggerKey).toBe(first.triggerKey)
		expect(nextOccurrence.triggerKey).not.toBe(first.triggerKey)
	})

	it('keys error-output notifications by matching occurrences', () => {
		const first = errorOutputCandidate('Error: one\n', 'Error: one\n')
		const progress = errorOutputCandidate('Error: one\nstill running\n', 'still running\n')
		const nextOccurrence = errorOutputCandidate(
			'Error: one\nstill running\nError: one\n',
			'Error: one\n',
		)

		if (!first || !nextOccurrence) throw new Error('Expected error-output candidates')
		expect(progress).toBeNull()
		expect(nextOccurrence.triggerKey).not.toBe(first.triggerKey)
	})

	it('disables notifications when delivering the final allowed message', () => {
		const decision = __testing.notificationDeliveryStateDecision(
			persistedMetadata({
				notifications: policy({ maxMessages: 1 }),
				notificationState: { sentCount: 0, lastSentAt: null, lastTriggerKey: null },
			}),
			{ triggerKey: 'contains:text:ready:1:test' },
			2_000,
		)

		if (decision.type !== 'deliver') throw new Error('Expected delivery decision')
		expect(decision.maxMessagesReached).toBe(true)
		expect(decision.metadata.notifications?.enabled).toBe(false)
		expect(decision.metadata.notificationState).toEqual({
			sentCount: 1,
			lastSentAt: 2_000,
			lastTriggerKey: 'contains:text:ready:1:test',
		})
	})

	it('disables without delivery when maxMessages is already exhausted', () => {
		const decision = __testing.notificationDeliveryStateDecision(
			persistedMetadata({
				notifications: policy({ enabled: true, maxMessages: 0 }),
				notificationState: { sentCount: 0, lastSentAt: null, lastTriggerKey: null },
			}),
			{ triggerKey: 'contains:text:ready:1:test' },
			2_000,
		)

		if (decision.type !== 'disable') throw new Error('Expected disable decision')
		expect(decision.metadata.notifications?.enabled).toBe(false)
		expect(decision.metadata.notificationState.sentCount).toBe(0)
	})

	it('mentions when notifications are disabled by the max message limit', () => {
		const message = __testing.formatNotificationMessage(
			taskRecord(),
			{
				reason: 'matched "ready"',
				triggerKey: 'contains:text:ready:1:test',
				debounceKey: 'contains:text:ready',
				includeSnapshot: true,
			},
			__testing.buildSnapshotResult({
				screen: 'screen output',
				recentOutput: {
					text: 'recent output',
					droppedChars: 0,
					maxChars: 20_000,
					truncated: false,
				},
				pane: null,
				fallbackDimensions: { cols: 80, rows: 24 },
				historyLines: 40,
				requestedHistoryLines: 40,
			}),
			{ maxMessagesReached: true, maxMessages: 1 },
		)

		expect(message).toContain('Background task bt_test: matched "ready".')
		expect(message).toContain('Recent output:\nrecent output')
		expect(message).toContain('Notifications are now disabled because maxMessages (1) was reached.')
	})

	it('does not suggest snapshotting an exited task that will be reaped', () => {
		const message = __testing.formatNotificationMessage(
			taskRecord(),
			{
				reason: 'process exited with status 0',
				triggerKey: 'exit:0',
				debounceKey: 'exit',
				includeSnapshot: false,
			},
			undefined,
			{ maxMessagesReached: false, maxMessages: 1 },
		)

		expect(message).toBe('Background task bt_test: process exited with status 0.')
	})
})

describe('parseTaskMetadata', () => {
	it('defaults missing activity timestamps to the creation time', () => {
		const metadata = persistedMetadata({ createdAt: 1_234, lastActivityAt: 5_678 })
		const parsed = parseTaskMetadata(JSON.stringify({ ...metadata, lastActivityAt: undefined }))

		expect(parsed?.createdAt).toBe(1_234)
		expect(parsed?.lastActivityAt).toBe(1_234)
	})

	it('preserves persisted activity timestamps', () => {
		const parsed = parseTaskMetadata(
			JSON.stringify(persistedMetadata({ createdAt: 1_234, lastActivityAt: 5_678 })),
		)

		expect(parsed?.lastActivityAt).toBe(5_678)
	})
})

function policy(overrides: Partial<NotificationPolicy>): NotificationPolicy {
	return {
		enabled: true,
		threadID: 'T-test',
		steer: true,
		cooldownMs: 0,
		debounceMs: 0,
		maxMessages: 5,
		triggers: [{ type: 'exit', includeSnapshot: true }],
		...overrides,
	}
}

function lifecycle(overrides: Partial<LifecycleMetadata>): LifecycleMetadata {
	return {
		createdAt: 1_000,
		lastActivityAt: 1_000,
		keepAlive: false,
		notifications: null,
		...overrides,
	}
}

function persistedMetadata(overrides: Partial<PersistedTaskMetadata>): PersistedTaskMetadata {
	return {
		schemaVersion: 1,
		taskID: 'bt_test',
		workspaceHash: 'workspace',
		owner: 'plugin',
		name: 'test',
		originThreadID: 'T-test',
		startKey: 'sha256:test',
		command: 'echo test',
		cwd: '/tmp',
		env: {},
		createdAt: 1_000,
		lastActivityAt: 1_000,
		keepAlive: false,
		sessionID: '$1',
		sessionName: 'amp-bg-workspace-bt-test',
		windowID: '@1',
		primaryPane: '%1',
		dimensions: { cols: 120, rows: 40 },
		notifications: null,
		notificationState: { sentCount: 0, lastSentAt: null, lastTriggerKey: null },
		...overrides,
	}
}

function containsCandidate(recentOutput: string) {
	return __testing.outputNotificationCandidate(
		{ type: 'contains', pattern: 'server ready', regex: false, includeSnapshot: true },
		recentOutput,
		recentOutput,
	)
}

function errorOutputCandidate(recentOutput: string, text: string) {
	return __testing.outputNotificationCandidate(
		{ type: 'error-output', includeSnapshot: true },
		recentOutput,
		text,
	)
}

function taskRecord() {
	const metadata = persistedMetadata({ notifications: policy({ maxMessages: 1 }) })
	return {
		metadata,
		session: { id: metadata.sessionID, name: metadata.sessionName },
		pane: null,
	}
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}
