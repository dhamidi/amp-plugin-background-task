type ByteArray = Uint8Array<ArrayBufferLike>

/**
 * Buffers arbitrary byte chunks into newline-delimited frames without decoding them.
 * The tmux parser uses it so control-mode output can preserve escaped pane bytes exactly.
 */
export class ByteLineFramer {
	private pending: ByteArray = new Uint8Array(0)

	push(chunk: ByteArray): ByteArray[] {
		const bytes = concatBytes(this.pending, chunk)
		const lines: ByteArray[] = []
		let lineStart = 0

		for (let index = 0; index < bytes.length; index++) {
			if (bytes[index] !== 0x0a) continue

			lines.push(stripTrailingCarriageReturn(bytes.subarray(lineStart, index)))
			lineStart = index + 1
		}

		this.pending = bytes.subarray(lineStart)
		return lines
	}

	flush(): ByteArray | null {
		if (this.pending.length === 0) return null
		const line = stripTrailingCarriageReturn(this.pending)
		this.pending = new Uint8Array(0)
		return line
	}
}

function concatBytes(first: ByteArray, second: ByteArray): ByteArray {
	if (first.length === 0) return second
	if (second.length === 0) return first

	const combined = new Uint8Array(first.length + second.length)
	combined.set(first, 0)
	combined.set(second, first.length)
	return combined
}

function stripTrailingCarriageReturn(bytes: ByteArray): ByteArray {
	if (bytes.at(-1) !== 0x0d) return bytes
	return bytes.subarray(0, bytes.length - 1)
}
