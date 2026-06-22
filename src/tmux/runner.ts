import { spawn } from 'node:child_process'

export interface TmuxRunResult {
	exitCode: number
	stdout: string
	stderr: string
}

export function tmuxUnavailableMessage(platform: NodeJS.Platform = process.platform): string {
	const backend =
		platform === 'win32'
			? 'https://github.com/psmux/psmux to be present as the Windows-compatible backend'
			: 'tmux to be present'
	return (
		`The background_task tool requires ${backend}. ` +
		'Ask the user whether they want to install the backend now.'
	)
}

/**
 * Domain error for hosts where the tmux-compatible executable cannot be started.
 * Tool responses surface this as an actionable install prompt instead of a low-level spawn error.
 */
export class TmuxUnavailableError extends Error {
	constructor(platform?: NodeJS.Platform) {
		super(tmuxUnavailableMessage(platform))
		this.name = 'TmuxUnavailableError'
	}

	toString(): string {
		return this.message
	}
}

export function normalizeTmuxSpawnError(error: unknown): Error {
	if (isExecutableMissingError(error)) {
		return new TmuxUnavailableError()
	}
	return error instanceof Error ? error : new Error(String(error))
}

/**
 * Thin process runner for one tmux socket namespace.
 * TmuxConnection uses it for short-lived tmux commands that inspect or mutate task sessions.
 */
export class TmuxRunner {
	constructor(
		private readonly socketName: string,
		private readonly executable = 'tmux',
	) {}

	async run(args: readonly string[], timeoutMs = 5_000): Promise<TmuxRunResult> {
		return new Promise<TmuxRunResult>((resolve, reject) => {
			const child = spawn(this.executable, ['-L', this.socketName, ...args], {
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			const stdoutChunks: Buffer[] = []
			const stderrChunks: Buffer[] = []
			let settled = false

			const timeout = setTimeout(() => {
				if (settled) return
				settled = true
				child.kill('SIGKILL')
				reject(new Error(`tmux command timed out after ${timeoutMs}ms: ${args.join(' ')}`))
			}, timeoutMs)

			child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
			child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
			child.on('error', (error) => {
				if (settled) return
				settled = true
				clearTimeout(timeout)
				reject(normalizeTmuxSpawnError(error))
			})
			child.on('close', (code) => {
				if (settled) return
				settled = true
				clearTimeout(timeout)
				resolve({
					exitCode: code ?? 1,
					stdout: Buffer.concat(stdoutChunks).toString('utf8'),
					stderr: Buffer.concat(stderrChunks).toString('utf8'),
				})
			})
		})
	}

	async runOrThrow(args: readonly string[], timeoutMs?: number): Promise<TmuxRunResult> {
		const result = await this.run(args, timeoutMs)
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `tmux exited with ${result.exitCode}`)
		}
		return result
	}
}

function isExecutableMissingError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false
	return 'code' in error && error.code === 'ENOENT'
}
