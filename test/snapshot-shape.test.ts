import { describe, expect, it } from 'bun:test'
import { __testing } from '../src/background-task-manager'

describe('buildSnapshotResult', () => {
	it('includes tmux metadata and truncation counters', () => {
		expect(
			__testing.buildSnapshotResult({
				screen: 'current screen',
				recentOutput: {
					text: '[dropped 123 chars]\nrecent output',
					droppedChars: 123,
					maxChars: 20_000,
					truncated: true,
				},
				pane: {
					sessionID: '$1',
					sessionName: 'dev',
					windowID: '@2',
					paneID: '%3',
					paneDead: true,
					paneDeadStatus: 2,
					currentCommand: 'node',
					currentPath: '/repo',
					cols: 120,
					rows: 40,
					cursor: { row: 10, col: 20 },
					historySize: 3_000,
				},
				fallbackDimensions: { cols: 80, rows: 24 },
				historyLines: 2_000,
				requestedHistoryLines: 5_000,
			}),
		).toEqual({
			screen: 'current screen',
			recentOutput: '[dropped 123 chars]\nrecent output',
			truncated: true,
			historyLines: 2_000,
			dimensions: { cols: 120, rows: 40 },
			cursor: { row: 10, col: 20 },
			currentCommand: 'node',
			currentPath: '/repo',
			paneDead: true,
			paneDeadStatus: 2,
			exitCode: 2,
			recentOutputDroppedChars: 123,
			recentOutputMaxChars: 20_000,
			recentOutputTruncated: true,
			historySize: 3_000,
			captureCapped: true,
			captureTruncated: true,
		})
	})
})
