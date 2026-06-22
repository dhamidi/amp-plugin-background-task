import type { AssertionDiagnostic } from './assertions'
import type { OperationLogEntry, ScenarioProgressEvent, ScenarioRunResult } from './runner'

export function formatProgressLine(event: ScenarioProgressEvent): string {
	const parts = [
		event.phase.toUpperCase(),
		event.scenarioID,
		event.stepID,
		event.action,
		...progressDetails(event),
	]
	return parts.filter((part) => part.length > 0).join(' ')
}

export function formatScenarioReport(results: readonly ScenarioRunResult[]): string {
	const lines: string[] = []
	for (const result of results) {
		lines.push(formatSummaryLine(result))
	}

	const failed = results.filter((result) => result.status === 'fail' || result.status === 'xpass')
	for (const result of failed) {
		lines.push('', result.scenario.id)
		for (const diagnostic of [...result.operationErrors, ...result.diagnostics]) {
			lines.push(...formatDiagnostic(diagnostic))
		}
		const last = result.log.at(-1)
		if (last !== undefined) lines.push('', ...formatLastResponse(last))
		if (result.tempDir !== null) lines.push(`  tempDir: ${result.tempDir}`)
	}

	return `${lines.join('\n')}\n`
}

export function hasFailingResults(results: readonly ScenarioRunResult[]): boolean {
	return results.some((result) => result.status === 'fail' || result.status === 'xpass')
}

function formatSummaryLine(result: ScenarioRunResult): string {
	const reason = result.scenario.reason ? ` ${result.scenario.reason}` : ''
	return `${result.status.toUpperCase()} ${result.scenario.id}${reason}`
}

function formatDiagnostic(diagnostic: AssertionDiagnostic): string[] {
	const lines = [`  ${diagnostic.message}`]
	if (diagnostic.context !== null) lines.push(`    context: ${diagnostic.context}`)
	if (diagnostic.expected !== null) lines.push(`    expected: ${diagnostic.expected}`)
	if (diagnostic.actual !== null) lines.push(`    actual: ${truncate(diagnostic.actual)}`)
	return lines
}

function formatLastResponse(entry: OperationLogEntry): string[] {
	return [
		`  Last canonical response for step "${entry.stepID}":`,
		`    action: ${entry.canonical.action ?? 'null'}`,
		`    status: ${entry.canonical.status ?? 'null'}`,
		`    matched: ${entry.canonical.matched ?? 'null'}`,
		`    task.id: ${entry.canonical.task?.id ?? 'null'}`,
		`    task.name: ${entry.canonical.task?.name ?? 'null'}`,
		`    error: ${entry.canonical.error ?? 'null'}`,
	]
}

function truncate(value: string): string {
	return value.length <= 1_000 ? value : `${value.slice(0, 1_000)}…`
}

function progressDetails(event: ScenarioProgressEvent): string[] {
	const details: string[] = []
	if (event.taskAlias !== null && event.action !== 'start') {
		details.push(`task=${event.taskAlias}`)
	}
	const name = event.attributes.name
	if (typeof name === 'string') details.push(`name=${quoteIfNeeded(name)}`)
	const cols = event.attributes.cols
	const rows = event.attributes.rows
	if (typeof cols === 'number' && typeof rows === 'number') details.push(`size=${cols}x${rows}`)
	const mode = event.attributes.mode
	if (typeof mode === 'string') details.push(`mode=${mode}`)
	const contains = event.matchers.find((matcher) => matcher.kind === 'contains')
	if (contains !== undefined) details.push(`contains=${quoteIfNeeded(contains.value)}`)
	const notContains = event.matchers.find((matcher) => matcher.kind === 'not-contains')
	if (notContains !== undefined) details.push(`notContains=${quoteIfNeeded(notContains.value)}`)
	if (event.attributes.exited === true) details.push('exited=true')
	const idleMs = event.attributes.idleMs
	if (typeof idleMs === 'number') details.push(`idleMs=${idleMs}`)
	if (event.text.length > 0) details.push(`text=${quoteIfNeeded(event.text)}`)
	if (event.keys.length > 0) details.push(`keys=${event.keys.join(',')}`)
	return details
}

function quoteIfNeeded(value: string): string {
	return /\s/.test(value) ? JSON.stringify(value) : value
}
