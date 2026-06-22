import { getCanonicalField } from './canonical-response'
import type { ScenarioAssertion, TextMatcher } from './parser'
import type { OperationLogEntry, RuntimeTaskState, ScenarioRuntimeState } from './runner'

export interface AssertionDiagnostic {
	message: string
	expected: string | null
	actual: string | null
	context: string | null
}

export interface AssertionEvaluationContext {
	assertions: readonly ScenarioAssertion[]
	steps: ReadonlyMap<string, OperationLogEntry>
	state: ScenarioRuntimeState
}

export function evaluateAssertions(context: AssertionEvaluationContext): AssertionDiagnostic[] {
	return context.assertions.flatMap((assertion) => evaluateAssertion(assertion, context))
}

function evaluateAssertion(
	assertion: ScenarioAssertion,
	context: AssertionEvaluationContext,
): AssertionDiagnostic[] {
	switch (assertion.type) {
		case 'expect-step':
			return evaluateStepAssertion(assertion, context)
		case 'expect-task':
			return evaluateTaskAssertion(assertion, context.state)
		case 'expect-output':
			return evaluateOutputAssertion(assertion, context.state)
		case 'expect-notification':
			return evaluateNotificationAssertion(assertion, context.state)
	}
}

function evaluateStepAssertion(
	assertion: ScenarioAssertion,
	context: AssertionEvaluationContext,
): AssertionDiagnostic[] {
	const step = requireStep(assertion, context.steps)
	if (step instanceof Error) return [diagnostic(step.message, null, null, assertion.type)]

	return [...evaluateAttributeFields(assertion, step), ...evaluateStepFields(assertion, step)]
}

function evaluateStepFields(
	assertion: ScenarioAssertion,
	step: OperationLogEntry,
): AssertionDiagnostic[] {
	return assertion.fields.flatMap((field) => {
		const actual = getCanonicalField(step.canonical, field.name)
		return evaluateMatchers(field.matchers, actual, `response field ${field.name}`)
	})
}

function evaluateTaskAssertion(
	assertion: ScenarioAssertion,
	state: ScenarioRuntimeState,
): AssertionDiagnostic[] {
	const task = requireTask(assertion, state)
	if (task instanceof Error) return [diagnostic(task.message, null, null, assertion.type)]

	return Object.entries(assertion.attributes).flatMap(([key, expected]) => {
		if (['task', 'step'].includes(key)) return []
		return compareValue(taskField(task, key), expected, `task ${assertion.taskAlias}.${key}`)
	})
}

function evaluateOutputAssertion(
	assertion: ScenarioAssertion,
	state: ScenarioRuntimeState,
): AssertionDiagnostic[] {
	const task = requireTask(assertion, state)
	if (task instanceof Error) return [diagnostic(task.message, null, null, assertion.type)]
	const output = task.snapshot?.screen || task.snapshot?.recentOutput || ''
	return evaluateMatchers(assertion.matchers, output, `output for task ${assertion.taskAlias}`)
}

function evaluateNotificationAssertion(
	assertion: ScenarioAssertion,
	state: ScenarioRuntimeState,
): AssertionDiagnostic[] {
	const notifications = state.events.filter((event) => event.type === 'notification')
	const matching =
		assertion.matchers.length === 0
			? notifications
			: notifications.filter(
					(event) =>
						evaluateMatchers(assertion.matchers, String(event.data ?? ''), 'notification')
							.length === 0,
				)
	const diagnostics: AssertionDiagnostic[] = []
	const expectedCount = assertion.attributes.count
	if (typeof expectedCount === 'number' && matching.length !== expectedCount) {
		diagnostics.push(
			diagnostic(
				'Notification count mismatch',
				String(expectedCount),
				String(matching.length),
				assertion.type,
			),
		)
	} else if (
		expectedCount === undefined &&
		assertion.matchers.length > 0 &&
		matching.length === 0
	) {
		diagnostics.push(
			diagnostic('No matching notification found', 'at least one', '0', assertion.type),
		)
	}
	return diagnostics
}

function evaluateAttributeFields(
	assertion: ScenarioAssertion,
	step: OperationLogEntry,
): AssertionDiagnostic[] {
	return Object.entries(assertion.attributes).flatMap(([key, expected]) => {
		if (['step', 'task'].includes(key)) return []
		return compareValue(
			getCanonicalField(step.canonical, key),
			expected,
			`${assertion.type}.${key}`,
		)
	})
}

function requireStep(
	assertion: ScenarioAssertion,
	steps: ReadonlyMap<string, OperationLogEntry>,
): OperationLogEntry | Error {
	if (assertion.step === null) return new Error(`<${assertion.type}> requires step="..."`)
	return steps.get(assertion.step) ?? new Error(`Unknown step "${assertion.step}"`)
}

function requireTask(
	assertion: ScenarioAssertion,
	state: ScenarioRuntimeState,
): RuntimeTaskState | Error {
	if (assertion.taskAlias === null) return new Error(`<${assertion.type}> requires task="..."`)
	return state.tasks.get(assertion.taskAlias) ?? new Error(`Unknown task "${assertion.taskAlias}"`)
}

function taskField(task: RuntimeTaskState, key: string): unknown {
	switch (key) {
		case 'id':
			return task.id
		case 'name':
			return task.name
		case 'status':
			return task.status
		default:
			return getNestedValue(task, key)
	}
}

function evaluateMatchers(
	matchers: readonly TextMatcher[],
	actual: unknown,
	context: string,
): AssertionDiagnostic[] {
	return matchers.flatMap((matcher) => evaluateMatcher(matcher, actual, context))
}

function evaluateMatcher(
	matcher: TextMatcher,
	actual: unknown,
	context: string,
): AssertionDiagnostic[] {
	if (matcher.kind === 'exists') {
		return actual === undefined || actual === null
			? [diagnostic('Expected value to exist', 'present', String(actual), context)]
			: []
	}

	const actualText = matcherText(actual)
	switch (matcher.kind) {
		case 'contains':
			return actualText.includes(matcher.value)
				? []
				: [diagnostic('Expected text to contain value', matcher.value, actualText, context)]
		case 'not-contains':
			return actualText.includes(matcher.value)
				? [diagnostic('Expected text not to contain value', matcher.value, actualText, context)]
				: []
		case 'equals':
			return actualText === matcher.value
				? []
				: [diagnostic('Expected text to equal value', matcher.value, actualText, context)]
		case 'matches': {
			const pattern = new RegExp(matcher.value, matcher.flags)
			return pattern.test(actualText)
				? []
				: [diagnostic('Expected text to match pattern', matcher.value, actualText, context)]
		}
	}
}

function compareValue(actual: unknown, expected: unknown, context: string): AssertionDiagnostic[] {
	if (valuesEqual(actual, expected)) return []
	return [diagnostic('Value mismatch', formatValue(expected), formatValue(actual), context)]
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
	if (typeof expected === 'number') return actual === expected
	if (typeof expected === 'boolean') return actual === expected
	return String(actual ?? '') === String(expected ?? '')
}

function matcherText(value: unknown): string {
	if (value === undefined || value === null) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

function diagnostic(
	message: string,
	expected: string | null,
	actual: string | null,
	context: string | null,
): AssertionDiagnostic {
	return { message, expected, actual, context }
}

function getNestedValue(value: unknown, path: string): unknown {
	let current: unknown = value
	for (const part of path.split('.')) {
		if (typeof current !== 'object' || current === null) return undefined
		current = (current as Record<string, unknown>)[part]
	}
	return current
}

function formatValue(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value)
}
