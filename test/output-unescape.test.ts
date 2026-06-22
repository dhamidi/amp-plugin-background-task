import { describe, expect, it } from 'bun:test'
import { decodeTmuxOutputValue } from '../src/tmux/output-unescape'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const backslash = String.fromCharCode(0x5c)

describe('decodeTmuxOutputValue', () => {
	it('decodes tmux octal escapes to bytes', () => {
		const decoded = decodeTmuxOutputValue(
			encoder.encode(`hello${backslash}012world${backslash}134done`),
		)

		expect(decoder.decode(decoded)).toBe('hello\nworld\\done')
	})

	it('preserves ordinary UTF-8 bytes', () => {
		const input = encoder.encode('é 漢字')

		expect(decodeTmuxOutputValue(input)).toEqual(input)
	})

	it('rejects malformed backslash escapes', () => {
		expect(() => decodeTmuxOutputValue(encoder.encode('hello\\world'))).toThrow(
			'Malformed tmux octal escape',
		)
	})
})
