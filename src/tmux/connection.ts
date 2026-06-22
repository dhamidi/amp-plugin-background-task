import {
	metadataOption,
	type PersistedTaskMetadata,
	startKeyOption,
	taskIDOption,
} from './metadata'
import { TmuxRunner } from './runner'

export interface TmuxSession {
	id: string
	name: string
}

export interface TmuxCursorPosition {
	row: number
	col: number
}

export interface TmuxPaneState {
	sessionID: string
	sessionName: string
	windowID: string
	paneID: string
	paneDead: boolean
	paneDeadStatus: number | null
	currentCommand: string
	currentPath: string
	cols: number
	rows: number
	cursor: TmuxCursorPosition | null
	historySize: number | null
}

const paneStateFormat = [
	'#{session_id}',
	'#{session_name}',
	'#{window_id}',
	'#{pane_id}',
	'#{pane_dead}',
	'#{pane_dead_status}',
	'#{pane_current_command}',
	'#{pane_current_path}',
	'#{pane_width}',
	'#{pane_height}',
	'#{cursor_y}',
	'#{cursor_x}',
	'#{history_size}',
].join('\t')

/**
 * Stateless command connection to the workspace tmux server.
 * Each method shells out to tmux on the configured socket; long-lived streaming is handled elsewhere.
 */
export class TmuxConnection {
	readonly runner: TmuxRunner

	constructor(readonly socketName: string) {
		this.runner = new TmuxRunner(socketName)
	}

	async listSessions(): Promise<TmuxSession[]> {
		const result = await this.runner.run(['list-sessions', '-F', '#{session_id}\t#{session_name}'])
		if (result.exitCode !== 0) return []

		return result.stdout
			.trim()
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => {
				const [id = '', name = ''] = line.split('\t')
				return { id, name }
			})
	}

	async getPaneState(target: string): Promise<TmuxPaneState | null> {
		const result = await this.runner.run(['display-message', '-p', '-t', target, paneStateFormat])
		if (result.exitCode !== 0) return null

		return parsePaneStateOutput(result.stdout)
	}

	async showOption(target: string, option: string): Promise<string | null> {
		const result = await this.runner.run(['show-options', '-qv', '-t', target, option])
		if (result.exitCode !== 0) return null
		const value = result.stdout.trimEnd()
		return value.length === 0 ? null : value
	}

	async writeMetadata(metadata: PersistedTaskMetadata): Promise<void> {
		const target = metadata.sessionID || metadata.sessionName
		await this.runner.runOrThrow([
			'set-option',
			'-q',
			'-t',
			target,
			metadataOption,
			JSON.stringify(metadata),
		])
		await this.runner.runOrThrow(['set-option', '-q', '-t', target, taskIDOption, metadata.taskID])
		if (metadata.startKey !== null) {
			await this.runner.runOrThrow([
				'set-option',
				'-q',
				'-t',
				target,
				startKeyOption,
				metadata.startKey,
			])
		}
	}

	async capturePane(target: string, historyLines: number): Promise<string> {
		const args = ['capture-pane', '-p', '-J', '-t', target]
		if (historyLines > 0) {
			args.push('-S', `-${historyLines}`)
		}
		const result = await this.runner.runOrThrow(args)
		return result.stdout.trimEnd()
	}

	async killSession(target: string): Promise<void> {
		await this.runner.runOrThrow(['kill-session', '-t', target])
	}
}

function parsePaneStateOutput(output: string): TmuxPaneState {
	const fields = output.trimEnd().split('\t')
	const [
		sessionID = '',
		sessionName = '',
		windowID = '',
		paneID = '',
		paneDead = '0',
		paneDeadStatus = '',
		currentCommand = '',
		currentPath = '',
		cols = '0',
		rows = '0',
		cursorRow = '',
		cursorCol = '',
		historySize = '',
	] = fields

	return {
		sessionID,
		sessionName,
		windowID,
		paneID,
		paneDead: paneDead === '1',
		paneDeadStatus: parseOptionalInteger(paneDeadStatus),
		currentCommand,
		currentPath,
		cols: parseInteger(cols) ?? 0,
		rows: parseInteger(rows) ?? 0,
		cursor: parseCursorPosition(cursorRow, cursorCol),
		historySize: parseOptionalInteger(historySize),
	}
}

function parseCursorPosition(row: string, col: string): TmuxCursorPosition | null {
	const parsedRow = parseOptionalInteger(row)
	const parsedCol = parseOptionalInteger(col)
	if (parsedRow === null || parsedCol === null) return null
	return { row: parsedRow, col: parsedCol }
}

function parseOptionalInteger(value: string): number | null {
	if (value.length === 0) return null
	return parseInteger(value)
}

function parseInteger(value: string): number | null {
	const parsed = Number(value)
	return Number.isInteger(parsed) ? parsed : null
}

export const __testing = { parsePaneStateOutput }
