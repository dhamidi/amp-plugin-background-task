import { describe, expect, it } from 'bun:test'
import { getCanonicalField, normalizeScenarioResult } from '../src/scenarios/canonical-response'

describe('normalizeScenarioResult', () => {
	it('normalizes current string tool results into stable response fields', () => {
		const canonical = normalizeScenarioResult(
			JSON.stringify({
				action: 'start',
				status: 'running',
				taskID: 'bt_123',
				task: {
					taskID: 'bt_123',
					name: 'reader',
					status: 'running',
					dimensions: { cols: 80, rows: 24 },
				},
				notifications: {
					triggers: [{ type: 'contains', pattern: 'ready' }],
				},
				snapshot: { screen: 'ready', recentOutput: 'ready', paneDead: false },
			}),
		)

		expect(canonical).toMatchObject({
			ok: true,
			action: 'start',
			status: 'running',
			task: { id: 'bt_123', name: 'reader', dimensions: { cols: 80, rows: 24 } },
			snapshot: { screen: 'ready', recentOutput: 'ready', paneDead: false },
		})
		expect(getCanonicalField(canonical, 'notifications.triggers.0.pattern')).toBe('ready')
	})
})
