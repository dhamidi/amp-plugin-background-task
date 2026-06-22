export function formatTmuxCommand(args: readonly string[]): string {
	if (args.length === 0) {
		throw new Error('tmux command requires at least one argument')
	}
	return args.map(formatTmuxCommandArgument).join(' ')
}

export function formatTmuxCommandArgument(arg: string): string {
	if (arg.includes('\0')) {
		throw new Error('tmux command arguments cannot contain NUL bytes')
	}
	return `'${arg.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/'/g, `'\\''`)}'`
}
