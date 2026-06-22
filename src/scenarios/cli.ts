#!/usr/bin/env bun

import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stderr, stdout } from 'node:process'
import { formatProgressLine, formatScenarioReport, hasFailingResults } from './reporter'
import { runScenarioFile } from './runner'
import { applyScenarioUpdates, updatesRequested } from './update'

interface CLIOptions {
	paths: string[]
	filter: string | null
	debug: boolean
	keepTemp: boolean
	updateExpectations: boolean
	updateStatus: boolean
}

async function main(argv: readonly string[]): Promise<void> {
	const options = parseArgs(argv)
	const files = (await scenarioFiles(options.paths)).filter(
		(file) => options.filter === null || file.includes(options.filter),
	)
	if (files.length === 0) {
		stderr.write('No scenario files found.\n')
		process.exit(1)
	}

	const results = []
	for (const file of files) {
		results.push(
			await runScenarioFile(file, {
				debug: options.debug,
				keepTemp: options.keepTemp,
				onProgress: (event) => stdout.write(`${formatProgressLine(event)}\n`),
			}),
		)
	}

	stdout.write(formatScenarioReport(results))
	if (updatesRequested(options)) {
		const summary = await applyScenarioUpdates(results, options)
		const expectationNoun = summary.updatedExpectations === 1 ? 'expectation' : 'expectations'
		const statusNoun = summary.updatedStatuses === 1 ? 'status value' : 'status values'
		const fileNoun = summary.updatedFiles === 1 ? 'file' : 'files'
		const message = [
			`Updated ${summary.updatedExpectations} ${expectationNoun}`,
			`and ${summary.updatedStatuses} ${statusNoun}`,
			`in ${summary.updatedFiles} ${fileNoun}.`,
		].join(' ')
		stdout.write(`${message}\n`)
	}
	if (hasFailingResults(results)) process.exit(1)
}

function parseArgs(argv: readonly string[]): CLIOptions {
	const paths: string[] = []
	let filter: string | null = null
	let debug = false
	let keepTemp = false
	let updateExpectations = false
	let updateStatus = false

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === undefined) continue
		if (arg === '--debug') {
			debug = true
			continue
		}
		if (arg === '--keep-temp') {
			keepTemp = true
			continue
		}
		if (arg === '--update-expectations') {
			updateExpectations = true
			continue
		}
		if (arg === '--update-status') {
			updateStatus = true
			continue
		}
		if (arg === '--filter') {
			filter = argv[index + 1] ?? null
			index++
			continue
		}
		paths.push(arg)
	}

	return { paths, filter, debug, keepTemp, updateExpectations, updateStatus }
}

async function scenarioFiles(paths: readonly string[]): Promise<string[]> {
	const roots = paths.length > 0 ? paths : ['test/scenarios']
	const files: string[] = []
	for (const root of roots) {
		files.push(...(await collectScenarioFiles(resolve(root))))
	}
	return files.sort((left, right) => left.localeCompare(right))
}

async function collectScenarioFiles(path: string): Promise<string[]> {
	let info
	try {
		info = await stat(path)
	} catch {
		return []
	}
	if (info.isFile()) return path.endsWith('.html') ? [path] : []
	if (!info.isDirectory()) return []

	const entries = await readdir(path, { withFileTypes: true })
	const nested = await Promise.all(
		entries.map((entry) => collectScenarioFiles(join(path, entry.name))),
	)
	return nested.flat()
}

if (import.meta.main) {
	try {
		await main(process.argv.slice(2))
	} catch (error) {
		stderr.write(`scenario-runner: ${error instanceof Error ? error.message : String(error)}\n`)
		process.exit(1)
	}
}
