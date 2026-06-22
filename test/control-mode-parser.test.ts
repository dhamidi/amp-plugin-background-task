import { describe, expect, it } from 'bun:test'
import { type ControlModeEvent, ControlModeParser } from '../src/tmux/control-mode-parser'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const backslash = String.fromCharCode(0x5c)

type PaneOutputEvent = Extract<ControlModeEvent, { type: 'pane-output' }>
type NotificationEvent = Extract<ControlModeEvent, { type: 'notification' }>

describe('ControlModeParser', () => {
	it('parses pane output as bytes', () => {
		const parser = new ControlModeParser()
		const events = parser.push(encoder.encode(`%output %1 hello${backslash}015${backslash}012\n`))

		expect(events).toHaveLength(1)
		const event = expectPaneOutput(events[0])
		expect(event).toMatchObject({ type: 'pane-output', paneID: '%1' })
		expect(decoder.decode(event.bytes)).toBe('hello\r\n')
	})

	it('parses extended pane output with age metadata', () => {
		const parser = new ControlModeParser()
		const events = parser.push(
			encoder.encode(`%extended-output %1 42 future flag : hello${backslash}012there\n`),
		)

		expect(events).toHaveLength(1)
		const event = expectPaneOutput(events[0])
		expect(event).toMatchObject({ type: 'pane-output', paneID: '%1', ageMs: 42 })
		expect(decoder.decode(event.bytes)).toBe('hello\nthere')
	})

	it('falls back to the last colon-space separator for extended pane output', () => {
		const parser = new ControlModeParser()
		const events = parser.push(
			encoder.encode('%extended-output %1 7 metadata: prefix: fallback text\n'),
		)

		expect(events).toHaveLength(1)
		const event = expectPaneOutput(events[0])
		expect(event).toMatchObject({ type: 'pane-output', paneID: '%1', ageMs: 7 })
		expect(decoder.decode(event.bytes)).toBe('fallback text')
	})

	it('keeps malformed extended pane output as a notification', () => {
		const parser = new ControlModeParser()
		const line = '%extended-output %1 7 missing separator'
		const events = parser.push(encoder.encode(`${line}\n`))

		expect(events).toHaveLength(1)
		expect(expectNotification(events[0])).toEqual({
			type: 'notification',
			name: 'extended-output',
			normalizedName: 'extended-output',
			args: '%1 7 missing separator',
			line,
		})
	})

	it('normalizes pause and continue notifications', () => {
		const parser = new ControlModeParser()
		const events = parser.push(encoder.encode('%pause %1\n%continue %1\n%pane_unpaused %2 extra\n'))

		expect(events).toHaveLength(3)
		expect(expectNotification(events[0])).toMatchObject({
			type: 'notification',
			name: 'pause',
			normalizedName: 'pause',
			args: '%1',
			paneID: '%1',
			flowControl: 'pause',
		})
		expect(expectNotification(events[1])).toMatchObject({
			type: 'notification',
			name: 'continue',
			normalizedName: 'continue',
			args: '%1',
			paneID: '%1',
			flowControl: 'continue',
		})
		expect(expectNotification(events[2])).toMatchObject({
			type: 'notification',
			name: 'pane_unpaused',
			normalizedName: 'pane-unpaused',
			args: '%2 extra',
			paneID: '%2',
			flowControl: 'continue',
		})
	})

	it('preserves split UTF-8 bytes across pane output events', () => {
		const parser = new ControlModeParser()
		const euro = encoder.encode('€')
		const events = [
			...parser.push(
				concatBytes(encoder.encode('%output %1 '), euro.subarray(0, 2), encoder.encode('\n')),
			),
			...parser.push(
				concatBytes(encoder.encode('%output %1 '), euro.subarray(2), encoder.encode('\n')),
			),
		]
		const streamDecoder = new TextDecoder()

		expect(events).toHaveLength(2)
		expect(streamDecoder.decode(expectPaneOutput(events[0]).bytes, { stream: true })).toBe('')
		expect(streamDecoder.decode(expectPaneOutput(events[1]).bytes, { stream: true })).toBe('€')
		expect(streamDecoder.decode()).toBe('')
	})

	it('parses command blocks', () => {
		const parser = new ControlModeParser()
		const events = parser.push(
			encoder.encode('%begin 1 2 0\nfirst line\nsecond line\n%end 1 2 0\n'),
		)

		expect(events).toEqual([
			{ type: 'command-end', output: 'first line\nsecond line', error: null },
		])
	})
})

function expectPaneOutput(event: ControlModeEvent | undefined): PaneOutputEvent {
	expect(event?.type).toBe('pane-output')
	if (event?.type !== 'pane-output') {
		throw new Error('Expected pane-output event')
	}
	return event
}

function expectNotification(event: ControlModeEvent | undefined): NotificationEvent {
	expect(event?.type).toBe('notification')
	if (event?.type !== 'notification') {
		throw new Error('Expected notification event')
	}
	return event
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
	const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
	const combined = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		combined.set(chunk, offset)
		offset += chunk.length
	}
	return combined
}
