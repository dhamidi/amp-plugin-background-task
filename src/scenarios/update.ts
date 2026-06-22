import { readFile, writeFile } from 'node:fs/promises'
import { getCanonicalField } from './canonical-response'
import type { FieldAssertion, ScenarioAssertion } from './parser'
import type { ScenarioRunResult } from './runner'

export interface UpdateOptions {
	updateExpectations: boolean
	updateStatus: boolean
}

export interface UpdateSummary {
	updatedFiles: number
	updatedExpectations: number
	updatedStatuses: number
}

export function updatesRequested(options: UpdateOptions): boolean {
	return options.updateExpectations || options.updateStatus
}

export async function applyScenarioUpdates(
	results: readonly ScenarioRunResult[],
	options: UpdateOptions,
): Promise<UpdateSummary> {
	let updatedFiles = 0
	let updatedExpectations = 0
	let updatedStatuses = 0

	for (const result of results) {
		let html = await readFile(result.scenario.filePath, 'utf8')
		const original = html
		if (options.updateExpectations) {
			const update = updateExpectationFields(html, result)
			html = update.html
			updatedExpectations += update.count
		}
		if (options.updateStatus) {
			const update = updateScenarioStatus(html, result)
			html = update.html
			updatedStatuses += update.count
		}
		if (html !== original) {
			await writeFile(result.scenario.filePath, html, 'utf8')
			updatedFiles++
		}
	}

	return { updatedFiles, updatedExpectations, updatedStatuses }
}

function updateExpectationFields(
	html: string,
	result: ScenarioRunResult,
): { html: string; count: number } {
	let output = html
	let count = 0
	for (const assertion of result.scenario.assertions) {
		for (const field of updateableFields(assertion)) {
			const step =
				assertion.step === null ? null : result.log.find((entry) => entry.stepID === assertion.step)
			if (step === null || step === undefined) continue
			const actual = getCanonicalField(step.canonical, field.name)
			const updated = replaceAutoFieldEquals(output, field.name, formatExpectedValue(actual))
			if (updated !== output) {
				output = updated
				count++
			}
		}
	}
	return { html: output, count }
}

function updateScenarioStatus(
	html: string,
	result: ScenarioRunResult,
): { html: string; count: number } {
	const expected = result.status === 'pass' || result.status === 'xpass' ? 'pass' : 'fail'
	const updated = html.replace(
		/(<scenario\b[^>]*\bexpected=["'])(pass|fail|skip)(["'][^>]*>)/i,
		`$1${expected}$3`,
	)
	return { html: updated, count: updated === html ? 0 : 1 }
}

function updateableFields(assertion: ScenarioAssertion): FieldAssertion[] {
	if (assertion.type !== 'expect-step') return []
	return assertion.fields.filter((field) => field.update === 'auto')
}

function replaceAutoFieldEquals(html: string, fieldName: string, value: string): string {
	const escapedFieldName = escapeRegExp(fieldName)
	const fieldStart = `<field\\b(?=[^>]*\\bname=["']${escapedFieldName}["'])`
	const updateAttribute = `(?=[^>]*\\bupdate=["']auto["'])`
	const equalsStart = `[^>]*>\\s*<equals(?:\\s[^>]*)?>`
	const pattern = new RegExp(
		`(${fieldStart}${updateAttribute}${equalsStart})([\\s\\S]*?)(</equals>\\s*</field>)`,
		'i',
	)
	return html.replace(pattern, (_match, before: string, _oldValue: string, after: string) => {
		return `${before}${escapeHTML(value)}${after}`
	})
}

function formatExpectedValue(value: unknown): string {
	if (value === undefined || value === null) return ''
	return typeof value === 'string' ? value : JSON.stringify(value)
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeHTML(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
