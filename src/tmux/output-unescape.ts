export function decodeTmuxOutputValue(value: Uint8Array): Uint8Array {
	const output: number[] = []

	for (let index = 0; index < value.length; index++) {
		const byte = value[index]!
		if (byte !== 0x5c) {
			output.push(byte)
			continue
		}

		const first = value[index + 1]
		const second = value[index + 2]
		const third = value[index + 3]
		if (!isOctalDigit(first) || !isOctalDigit(second) || !isOctalDigit(third)) {
			throw new Error(`Malformed tmux octal escape at byte offset ${index}`)
		}

		output.push(((first - 0x30) << 6) | ((second - 0x30) << 3) | (third - 0x30))
		index += 3
	}

	return Uint8Array.from(output)
}

function isOctalDigit(byte: number | undefined): byte is number {
	return byte !== undefined && byte >= 0x30 && byte <= 0x37
}
