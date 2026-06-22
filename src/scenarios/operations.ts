import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackgroundTaskAction } from '../background-task-manager'
import type { ScenarioOperation } from './parser'

export interface OperationCompileContext {
	scenarioID: string
	scriptRoot: string
	defaults: Record<string, unknown>
	taskAliases: ReadonlyMap<string, string>
}

export interface CompiledOperation {
	stepID: string
	action: BackgroundTaskAction
	taskAlias: string | null
	input: Record<string, unknown>
	scriptPath: string | null
}

const taskScopedActions = new Set<BackgroundTaskAction>([
	'send',
	'snapshot',
	'wait',
	'configure_notifications',
	'resize',
	'stop',
])

export async function compileOperation(
	operation: ScenarioOperation,
	context: OperationCompileContext,
): Promise<CompiledOperation> {
	if (operation.action === 'runner-restart') {
		throw new Error('<runner-restart> is handled by the scenario runner')
	}

	const action = operation.action
	const input: Record<string, unknown> = {
		action,
		...context.defaults,
		...operation.attributes,
	}
	let scriptPath: string | null = null

	if (taskScopedActions.has(action)) {
		input.taskID = resolveTaskID(operation, context.taskAliases)
	}

	if (action === 'start') {
		if (operation.script === null) {
			throw new Error(`<bt-start id="${operation.id}"> requires an embedded <script>`)
		}
		scriptPath = await materializeScript(operation, context)
		input.command = `bun run ${shellQuote(scriptPath)}`
		if (input.name === undefined) input.name = operation.id
	}

	if (action === 'send') {
		if (operation.text.length > 0) input.text = operation.text
		if (operation.keys.length > 0) input.keys = operation.keys
	}

	if (action === 'wait') {
		const contains = operation.matchers.find((matcher) => matcher.kind === 'contains')
		const notContains = operation.matchers.find((matcher) => matcher.kind === 'not-contains')
		if (contains !== undefined && input.contains === undefined) input.contains = contains.value
		if (notContains !== undefined && input.notContains === undefined) {
			input.notContains = notContains.value
		}
	}

	if (operation.notifications !== null) {
		input.notifications = operation.notifications
	}

	return {
		stepID: operation.id,
		action,
		taskAlias: operation.taskAlias,
		input,
		scriptPath,
	}
}

function resolveTaskID(
	operation: ScenarioOperation,
	taskAliases: ReadonlyMap<string, string>,
): string {
	if (operation.taskAlias === null) {
		throw new Error(`<${operation.tagName} id="${operation.id}"> requires task="..."`)
	}
	const taskID = taskAliases.get(operation.taskAlias)
	if (taskID === undefined) {
		throw new Error(`Unknown task alias "${operation.taskAlias}" for step "${operation.id}"`)
	}
	return taskID
}

async function materializeScript(
	operation: ScenarioOperation,
	context: OperationCompileContext,
): Promise<string> {
	await mkdir(context.scriptRoot, { recursive: true })
	const scriptPath = join(context.scriptRoot, `${sanitizeFileName(operation.id)}.js`)
	await writeFile(scriptPath, `${operation.script?.source ?? ''}\n`, 'utf8')
	return scriptPath
}

function sanitizeFileName(value: string): string {
	return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'scenario-step'
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}
