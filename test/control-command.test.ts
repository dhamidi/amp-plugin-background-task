import { describe, expect, it } from 'bun:test'
import { formatTmuxCommand, formatTmuxCommandArgument } from '../src/tmux/control-command'

describe('formatTmuxCommand', () => {
	it('quotes command arguments for tmux control mode', () => {
		expect(
			formatTmuxCommand(['send-keys', '-t', '%1', '-l', `hello world; $x "double" \\slash café`]),
		).toBe(`'send-keys' '-t' '%1' '-l' 'hello world; $x "double" \\slash café'`)
	})

	it('escapes single quotes without exposing command separators', () => {
		expect(formatTmuxCommandArgument(`it's; fine`)).toBe(`'it'\\''s; fine'`)
	})

	it('keeps control commands single-line', () => {
		expect(formatTmuxCommandArgument('first\r\nsecond')).toBe(`'first\\r\\nsecond'`)
	})

	it('rejects nul bytes', () => {
		expect(() => formatTmuxCommandArgument('bad\0arg')).toThrow(
			'tmux command arguments cannot contain NUL bytes',
		)
	})
})
