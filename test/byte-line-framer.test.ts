import { describe, expect, it } from 'bun:test'
import { ByteLineFramer } from '../src/tmux/byte-line-framer'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('ByteLineFramer', () => {
	it('frames newline-delimited byte chunks', () => {
		const framer = new ByteLineFramer()

		expect(framer.push(encoder.encode('one\ntwo\n')).map((line) => decoder.decode(line))).toEqual([
			'one',
			'two',
		])
		expect(framer.flush()).toBeNull()
	})

	it('preserves partial lines across chunks', () => {
		const framer = new ByteLineFramer()

		expect(framer.push(encoder.encode('one'))).toEqual([])
		expect(framer.push(encoder.encode(' two\n')).map((line) => decoder.decode(line))).toEqual([
			'one two',
		])
	})

	it('strips a carriage return before newline', () => {
		const framer = new ByteLineFramer()

		expect(framer.push(encoder.encode('one\r\n')).map((line) => decoder.decode(line))).toEqual([
			'one',
		])
	})
})
