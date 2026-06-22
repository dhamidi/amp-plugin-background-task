import { type ChildProcess, spawn } from 'node:child_process'
import { formatTmuxCommand } from './control-command'
import { type ControlModeEvent, ControlModeParser } from './control-mode-parser'
import { normalizeTmuxSpawnError } from './runner'

interface ControlClientOptions {
	socketName: string
	target: string
	onOutput: (paneID: string, text: string) => void
	onExit?: () => void
}

interface PendingCommand {
	command: string
	resolve: (output: string) => void
	reject: (error: Error) => void
}

/**
 * Long-lived tmux control-mode attachment for one managed task session.
 * It streams pane output to the manager and serializes interactive tmux commands over one client.
 */
export class ControlClient {
	private readonly parser = new ControlModeParser()
	private readonly paneDecoders = new Map<string, TextDecoder>()
	private readonly pausedPaneIDs = new Set<string>()
	private readonly queue: PendingCommand[] = []
	private child: ChildProcess | null = null
	private activeCommand: PendingCommand | null = null
	private disposed = false
	private ready = false

	constructor(private readonly options: ControlClientOptions) {}

	start(): void {
		if (this.child !== null) return
		if (this.disposed) throw new Error('Control client is disposed')

		const child = spawn(
			'tmux',
			['-L', this.options.socketName, '-C', 'attach-session', '-t', this.options.target],
			{ stdio: ['pipe', 'pipe', 'pipe'] },
		)
		this.child = child
		this.ready = false
		this.pausedPaneIDs.clear()

		child.stdout?.on('data', (chunk: Buffer) => {
			for (const event of this.parser.push(chunk)) {
				this.handleEvent(event)
			}
		})
		child.on('error', (error) => {
			this.child = null
			this.pausedPaneIDs.clear()
			this.rejectActiveAndQueued(normalizeTmuxSpawnError(error))
			this.options.onExit?.()
		})
		child.on('exit', () => {
			for (const event of this.parser.flush()) {
				this.handleEvent(event)
			}
			this.child = null
			this.pausedPaneIDs.clear()
			this.rejectActiveAndQueued(new Error('tmux control client exited'))
			this.options.onExit?.()
		})
	}

	async sendCommand(command: readonly string[] | string): Promise<string> {
		this.start()
		const commandText = typeof command === 'string' ? command : formatTmuxCommand(command)
		return new Promise<string>((resolve, reject) => {
			this.queue.push({ command: commandText, resolve, reject })
			this.drainQueue()
		})
	}

	isPanePaused(paneID: string): boolean {
		return this.pausedPaneIDs.has(paneID)
	}

	getPausedPaneIDs(): string[] {
		return [...this.pausedPaneIDs]
	}

	dispose(): void {
		this.disposed = true
		this.pausedPaneIDs.clear()
		this.child?.stdin?.write('detach-client\n')
		setTimeout(() => this.child?.kill('SIGTERM'), 100).unref()
		this.rejectActiveAndQueued(new Error('Control client disposed'))
	}

	private handleEvent(event: ControlModeEvent): void {
		switch (event.type) {
			case 'pane-output': {
				const decoder = this.decoderForPane(event.paneID)
				const text = decoder.decode(event.bytes, { stream: true })
				if (text.length > 0) {
					this.options.onOutput(event.paneID, text)
				}
				return
			}
			case 'command-end': {
				if (this.activeCommand === null && !this.ready) {
					this.ready = true
					this.drainQueue()
					return
				}

				const active = this.activeCommand
				this.activeCommand = null
				if (active) {
					if (event.error !== null) {
						active.reject(new Error(event.error || `tmux command failed: ${active.command}`))
					} else {
						active.resolve(event.output)
					}
				}
				this.drainQueue()
				return
			}
			case 'exit':
				this.child = null
				this.pausedPaneIDs.clear()
				this.options.onExit?.()
				return
			case 'notification':
				this.handleNotification(event)
				return
		}
	}

	private handleNotification(event: Extract<ControlModeEvent, { type: 'notification' }>): void {
		if (event.flowControl === 'pause' && event.paneID) {
			this.pausedPaneIDs.add(event.paneID)
			return
		}
		if (event.flowControl === 'continue' && event.paneID) {
			this.pausedPaneIDs.delete(event.paneID)
		}
	}

	private drainQueue(): void {
		if (!this.ready) return
		if (this.activeCommand !== null) return
		const next = this.queue.shift()
		if (!next) return

		if (!this.child?.stdin?.writable) {
			next.reject(new Error('tmux control client is not writable'))
			return
		}

		this.activeCommand = next
		this.child.stdin.write(`${next.command}\n`)
	}

	private rejectActiveAndQueued(error: Error): void {
		this.activeCommand?.reject(error)
		this.activeCommand = null
		for (const queued of this.queue.splice(0)) {
			queued.reject(error)
		}
	}

	private decoderForPane(paneID: string): TextDecoder {
		const existing = this.paneDecoders.get(paneID)
		if (existing) return existing

		const decoder = new TextDecoder()
		this.paneDecoders.set(paneID, decoder)
		return decoder
	}
}
