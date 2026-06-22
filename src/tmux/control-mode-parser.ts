import { ByteLineFramer } from './byte-line-framer'
import { decodeTmuxOutputValue } from './output-unescape'

export type ControlModeEvent =
	| CommandEndEvent
	| PaneOutputEvent
	| ControlModeNotificationEvent
	| ClientExitEvent

export interface CommandEndEvent {
	type: 'command-end'
	output: string
	error: string | null
}

export interface PaneOutputEvent {
	type: 'pane-output'
	paneID: string
	bytes: Uint8Array
	ageMs?: number
}

export type ControlModeNotificationFlowControl = 'pause' | 'continue'

export interface ControlModeNotificationEvent {
	type: 'notification'
	name: string
	normalizedName: string
	args: string
	line: string
	paneID?: string
	flowControl?: ControlModeNotificationFlowControl
}

export interface ClientExitEvent {
	type: 'exit'
}

const decoder = new TextDecoder()
const outputPrefix = '%output '
const extendedOutputCommand = '%extended-output'
const extendedOutputPrefix = `${extendedOutputCommand} `
const spaceByte = 0x20

/**
 * Incrementally parses tmux control-mode stdout into typed events.
 * ControlClient uses it to turn raw process bytes into command results, notifications, and pane output.
 */
export class ControlModeParser {
	private readonly framer = new ByteLineFramer()
	private blockLines: string[] | null = null

	push(chunk: Uint8Array): ControlModeEvent[] {
		return this.framer.push(chunk).flatMap((line) => this.parseLine(line))
	}

	flush(): ControlModeEvent[] {
		const line = this.framer.flush()
		return line === null ? [] : this.parseLine(line)
	}

	private parseLine(line: Uint8Array): ControlModeEvent[] {
		if (this.blockLines !== null) {
			const text = decoder.decode(line)
			if (text.startsWith('%end ')) {
				return [this.finishBlock(null)]
			}
			if (text.startsWith('%error ')) {
				return [this.finishBlock(this.blockLines.join('\n'))]
			}
			this.blockLines.push(text)
			return []
		}

		if (startsWithASCII(line, outputPrefix)) {
			return [parsePaneOutput(line)]
		}
		if (startsWithASCII(line, extendedOutputPrefix)) {
			return [parseExtendedPaneOutput(line)]
		}

		const text = decoder.decode(line)
		if (text.startsWith('%begin ')) {
			this.blockLines = []
			return []
		}
		if (text === '%exit') {
			return [{ type: 'exit' }]
		}
		if (text.startsWith('%')) {
			return [parseNotificationText(text)]
		}
		return []
	}

	private finishBlock(error: string | null): ControlModeEvent {
		const output = this.blockLines?.join('\n') ?? ''
		this.blockLines = null
		return { type: 'command-end', output, error }
	}
}

function parsePaneOutput(line: Uint8Array): PaneOutputEvent {
	const paneStart = outputPrefix.length
	const valueSeparator = line.indexOf(spaceByte, paneStart)
	if (valueSeparator === -1) {
		throw new Error(`Malformed tmux %output line: ${decoder.decode(line)}`)
	}

	return {
		type: 'pane-output',
		paneID: decoder.decode(line.subarray(paneStart, valueSeparator)),
		bytes: decodeTmuxOutputValue(line.subarray(valueSeparator + 1)),
	}
}

function parseExtendedPaneOutput(line: Uint8Array): ControlModeEvent {
	const paneStart = skipSpaces(line, extendedOutputCommand.length)
	const paneEnd = line.indexOf(spaceByte, paneStart)
	if (paneStart >= line.length || paneEnd === -1) {
		return parseNotificationLine(line)
	}

	const separator = findExtendedOutputValueSeparator(line, paneEnd)
	if (separator === null) {
		return parseNotificationLine(line)
	}

	const event: PaneOutputEvent = {
		type: 'pane-output',
		paneID: decoder.decode(line.subarray(paneStart, paneEnd)),
		bytes: decodeTmuxOutputValue(line.subarray(separator.valueStart)),
	}
	const ageMs = parseExtendedOutputAge(line, paneEnd, separator.start)
	if (ageMs !== null) {
		event.ageMs = ageMs
	}
	return event
}

interface ExtendedOutputValueSeparator {
	start: number
	valueStart: number
}

function findExtendedOutputValueSeparator(
	line: Uint8Array,
	searchStart: number,
): ExtendedOutputValueSeparator | null {
	const standaloneColon = indexOfASCIISequence(line, ' : ', searchStart)
	if (standaloneColon !== -1) {
		return { start: standaloneColon, valueStart: standaloneColon + 3 }
	}

	const colonSpace = lastIndexOfASCIISequence(line, ': ', searchStart)
	if (colonSpace !== -1) {
		return { start: colonSpace, valueStart: colonSpace + 2 }
	}
	return null
}

function parseExtendedOutputAge(
	line: Uint8Array,
	searchStart: number,
	fieldsEnd: number,
): number | null {
	const ageStart = skipSpaces(line, searchStart)
	if (ageStart >= fieldsEnd) return null

	const ageEnd = Math.min(indexOfSpace(line, ageStart), fieldsEnd)
	const ageText = decoder.decode(line.subarray(ageStart, ageEnd))
	if (!/^\d+$/.test(ageText)) return null

	const ageMs = Number.parseInt(ageText, 10)
	return Number.isSafeInteger(ageMs) ? ageMs : null
}

function parseNotificationLine(line: Uint8Array): ControlModeNotificationEvent {
	return parseNotificationText(decoder.decode(line))
}

function parseNotificationText(text: string): ControlModeNotificationEvent {
	const firstSpace = text.indexOf(' ')
	if (firstSpace === -1) {
		return createNotificationEvent(text.slice(1), '', text)
	}
	return createNotificationEvent(text.slice(1, firstSpace), text.slice(firstSpace + 1), text)
}

function createNotificationEvent(
	name: string,
	args: string,
	line: string,
): ControlModeNotificationEvent {
	const normalizedName = normalizeNotificationName(name)
	const event: ControlModeNotificationEvent = {
		type: 'notification',
		name,
		normalizedName,
		args,
		line,
	}
	const flowControl = notificationFlowControl(normalizedName)
	const paneID = firstNotificationArg(args)
	if (flowControl !== null && paneID !== null) {
		event.flowControl = flowControl
		event.paneID = paneID
	}
	return event
}

function notificationFlowControl(name: string): ControlModeNotificationFlowControl | null {
	if (
		name === 'pause' ||
		name === 'paused' ||
		name === 'pane-pause' ||
		name === 'pane-paused' ||
		name === 'output-pause' ||
		name === 'output-paused'
	) {
		return 'pause'
	}
	if (
		name === 'continue' ||
		name === 'continued' ||
		name === 'unpause' ||
		name === 'unpaused' ||
		name === 'pane-continue' ||
		name === 'pane-continued' ||
		name === 'pane-unpause' ||
		name === 'pane-unpaused' ||
		name === 'output-continue' ||
		name === 'output-continued' ||
		name === 'output-unpause' ||
		name === 'output-unpaused'
	) {
		return 'continue'
	}
	return null
}

function normalizeNotificationName(name: string): string {
	return name.toLowerCase().replaceAll('_', '-')
}

function firstNotificationArg(args: string): string | null {
	const trimmed = args.trimStart()
	if (trimmed.length === 0) return null

	const firstWhitespace = trimmed.search(/\s/)
	return firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace)
}

function skipSpaces(bytes: Uint8Array, start: number): number {
	let index = start
	while (bytes[index] === spaceByte) {
		index++
	}
	return index
}

function indexOfSpace(bytes: Uint8Array, start: number): number {
	const index = bytes.indexOf(spaceByte, start)
	return index === -1 ? bytes.length : index
}

function indexOfASCIISequence(bytes: Uint8Array, sequence: string, start: number): number {
	for (let index = start; index <= bytes.length - sequence.length; index++) {
		if (matchesASCIISequence(bytes, sequence, index)) return index
	}
	return -1
}

function lastIndexOfASCIISequence(bytes: Uint8Array, sequence: string, start: number): number {
	for (let index = bytes.length - sequence.length; index >= start; index--) {
		if (matchesASCIISequence(bytes, sequence, index)) return index
	}
	return -1
}

function matchesASCIISequence(bytes: Uint8Array, sequence: string, start: number): boolean {
	for (let index = 0; index < sequence.length; index++) {
		if (bytes[start + index] !== sequence.charCodeAt(index)) return false
	}
	return true
}

function startsWithASCII(bytes: Uint8Array, prefix: string): boolean {
	return matchesASCIISequence(bytes, prefix, 0)
}
