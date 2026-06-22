export interface CanonicalResponse {
	ok: boolean
	action: string | null
	status: string | null
	message: string | null
	matched: boolean | null
	reason: string | null
	task: CanonicalTask | null
	tasks: CanonicalTask[]
	snapshot: CanonicalSnapshot | null
	notifications: unknown
	error: string | null
	raw: unknown
}

export interface CanonicalTask {
	id: string | null
	name: string | null
	status: string | null
	owner: string | null
	command: string | null
	cwd: string | null
	exitCode: number | null
	dimensions: { cols: number | null; rows: number | null }
	backend: unknown
	raw: unknown
}

export interface CanonicalSnapshot {
	screen: string
	recentOutput: string
	dimensions: { cols: number | null; rows: number | null }
	paneDead: boolean | null
	exitCode: number | null
	raw: unknown
}

export function normalizeScenarioResult(
	raw: unknown,
	error: Error | null = null,
): CanonicalResponse {
	if (error !== null) {
		return emptyCanonicalResponse({ ok: false, raw, error: error.message })
	}

	const envelope = asRecord(raw)
	if (envelope !== null && envelope.ok === false) {
		return emptyCanonicalResponse({
			ok: false,
			raw,
			error: typeof envelope.error === 'string' ? envelope.error : 'scenario request failed',
		})
	}

	const toolResult = envelope !== null && 'result' in envelope ? envelope.result : raw
	const result = parseToolResult(toolResult)
	const resultRecord = asRecord(result)
	if (resultRecord === null) {
		return emptyCanonicalResponse({ ok: true, raw })
	}

	const task = normalizeTask(resultRecord.task ?? resultRecord)
	const tasks = Array.isArray(resultRecord.tasks)
		? resultRecord.tasks
				.map(normalizeTask)
				.filter((entry): entry is CanonicalTask => entry !== null)
		: []
	const snapshot = normalizeSnapshot(resultRecord.snapshot)
	return {
		ok: true,
		action: stringField(resultRecord, 'action'),
		status: stringField(resultRecord, 'status') ?? task?.status ?? null,
		message: stringField(resultRecord, 'message'),
		matched: booleanField(resultRecord, 'matched'),
		reason: stringField(resultRecord, 'reason'),
		task,
		tasks,
		snapshot,
		notifications: resultRecord.notifications,
		error: null,
		raw,
	}
}

export function getCanonicalField(response: CanonicalResponse, path: string): unknown {
	return getPathValue(response, path)
}

function parseToolResult(value: unknown): unknown {
	if (typeof value !== 'string') return value
	try {
		return JSON.parse(value) as unknown
	} catch {
		return value
	}
}

function normalizeTask(value: unknown): CanonicalTask | null {
	const record = asRecord(value)
	if (record === null) return null
	const dimensions = asRecord(record.dimensions)
	return {
		id: stringField(record, 'taskID') ?? stringField(record, 'id'),
		name: stringField(record, 'name'),
		status: stringField(record, 'status'),
		owner: stringField(record, 'owner'),
		command: stringField(record, 'command'),
		cwd: stringField(record, 'cwd'),
		exitCode: numberField(record, 'exitCode'),
		dimensions: {
			cols: dimensions ? numberField(dimensions, 'cols') : null,
			rows: dimensions ? numberField(dimensions, 'rows') : null,
		},
		backend: record.backend,
		raw: value,
	}
}

function normalizeSnapshot(value: unknown): CanonicalSnapshot | null {
	const record = asRecord(value)
	if (record === null) return null
	const dimensions = asRecord(record.dimensions)
	return {
		screen: stringField(record, 'screen') ?? '',
		recentOutput: stringField(record, 'recentOutput') ?? '',
		dimensions: {
			cols: dimensions ? numberField(dimensions, 'cols') : null,
			rows: dimensions ? numberField(dimensions, 'rows') : null,
		},
		paneDead: booleanField(record, 'paneDead'),
		exitCode: numberField(record, 'exitCode'),
		raw: value,
	}
}

function emptyCanonicalResponse(options: {
	ok: boolean
	raw: unknown
	error?: string | null
}): CanonicalResponse {
	return {
		ok: options.ok,
		action: null,
		status: null,
		message: null,
		matched: null,
		reason: null,
		task: null,
		tasks: [],
		snapshot: null,
		notifications: null,
		error: options.error ?? null,
		raw: options.raw,
	}
}

function getPathValue(value: unknown, path: string): unknown {
	let current: unknown = value
	for (const part of path.split('.')) {
		if (Array.isArray(current)) {
			const index = Number(part)
			if (!Number.isInteger(index)) return undefined
			current = current[index]
			continue
		}
		const record = asRecord(current)
		if (record === null) return undefined
		current = record[part]
	}
	return current
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function stringField(value: Record<string, unknown>, key: string): string | null {
	const field = value[key]
	return typeof field === 'string' ? field : null
}

function numberField(value: Record<string, unknown>, key: string): number | null {
	const field = value[key]
	return typeof field === 'number' && Number.isFinite(field) ? field : null
}

function booleanField(value: Record<string, unknown>, key: string): boolean | null {
	const field = value[key]
	return typeof field === 'boolean' ? field : null
}
