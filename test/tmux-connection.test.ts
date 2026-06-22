import { describe, expect, it } from 'bun:test'
import { __testing } from '../src/tmux/connection'
import { TmuxRunner, TmuxUnavailableError, tmuxUnavailableMessage } from '../src/tmux/runner'

describe('TmuxConnection pane state parsing', () => {
	it('parses tmux pane metadata', () => {
		expect(
			__testing.parsePaneStateOutput(
				'$1\tdev\t@2\t%3\t1\t7\tbash\t/tmp/project\t132\t43\t12\t34\t500\n',
			),
		).toEqual({
			sessionID: '$1',
			sessionName: 'dev',
			windowID: '@2',
			paneID: '%3',
			paneDead: true,
			paneDeadStatus: 7,
			currentCommand: 'bash',
			currentPath: '/tmp/project',
			cols: 132,
			rows: 43,
			cursor: { row: 12, col: 34 },
			historySize: 500,
		})
	})

	it('uses nulls for unavailable optional tmux fields', () => {
		expect(
			__testing.parsePaneStateOutput('$1\tdev\t@2\t%3\t0\t\t\t\t80\t24\t\t\t\n'),
		).toMatchObject({
			paneDead: false,
			paneDeadStatus: null,
			currentCommand: '',
			currentPath: '',
			cols: 80,
			rows: 24,
			cursor: null,
			historySize: null,
		})
	})
})

describe('TmuxRunner', () => {
	it('reports a missing tmux executable as an installable backend', async () => {
		const runner = new TmuxRunner('amp-test-missing-tmux', 'amp-background-task-missing-tmux')

		await expect(runner.run(['list-sessions'])).rejects.toThrow(tmuxUnavailableMessage())
	})

	it('serializes missing backend errors without an Error prefix', () => {
		const error = new TmuxUnavailableError('darwin')

		expect(String(error)).toBe(tmuxUnavailableMessage('darwin'))
		expect(String(error).startsWith('Error: ')).toBe(false)
	})

	it('only mentions psmux on Windows', () => {
		expect(tmuxUnavailableMessage('darwin')).not.toContain('psmux')
		expect(tmuxUnavailableMessage('linux')).not.toContain('psmux')
		expect(tmuxUnavailableMessage('win32')).toBe(
			'The background_task tool requires https://github.com/psmux/psmux to be present ' +
				'as the Windows-compatible backend. Ask the user whether they want to install ' +
				'the backend now.',
		)
	})
})
