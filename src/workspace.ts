import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function findWorkspaceRoot(startPath = process.cwd()): string {
	let current = resolve(startPath)
	for (;;) {
		if (existsSync(join(current, 'pnpm-workspace.yaml')) && existsSync(join(current, '.amp'))) {
			return current
		}

		const parent = dirname(current)
		if (parent === current) {
			return resolve(startPath)
		}
		current = parent
	}
}

export function workspaceHash(workspaceRoot: string): string {
	return createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12)
}

export function tmuxSocketNameForWorkspace(hash: string): string {
	return `amp-bg-${hash}`
}
