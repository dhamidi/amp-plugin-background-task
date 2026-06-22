import { describe, expect, it } from 'bun:test'
import { parseScenarioHTML } from '../src/scenarios/parser'

describe('parseScenarioHTML', () => {
	it('parses JavaScript-backed task operations and child matchers', async () => {
		const scenario = await parseScenarioHTML(`
			<scenario id="parser-smoke" expected="pass">
				<summary>Parser smoke.</summary>
				<defaults wait-for-idle-ms="200"></defaults>
				<run>
					<bt-start id="reader" name="Reader">
						<script type="application/javascript">
							console.log('ready')
						</script>
					</bt-start>
					<bt-send id="send" task="reader">
						hello
						<key>Enter</key>
					</bt-send>
					<bt-wait id="ready" task="reader" timeout-ms="1000">
						<contains>ready</contains>
					</bt-wait>
				</run>
			</scenario>
		`)

		expect(scenario.id).toBe('parser-smoke')
		expect(scenario.defaults.waitForIdleMs).toBe(200)
		expect(scenario.run[0]).toMatchObject({ action: 'start', id: 'reader' })
		expect(scenario.run[0]?.script?.source).toBe("console.log('ready')")
		expect(scenario.run[1]).toMatchObject({ action: 'send', text: 'hello', keys: ['Enter'] })
		expect(scenario.run[2]?.matchers[0]).toMatchObject({ kind: 'contains', value: 'ready' })
	})

	it('parses preformatted send text as multiline input', async () => {
		const scenario = await parseScenarioHTML(`
			<scenario id="send-pre">
				<run>
					<bt-send id="send" task="reader">
						<pre>
							first line
							second line
						</pre>
						<key>Enter</key>
					</bt-send>
				</run>
			</scenario>
		`)

		expect(scenario.run[0]).toMatchObject({
			action: 'send',
			text: 'first line\nsecond line',
			keys: ['Enter'],
		})
	})

	it('rejects send operations with multiple preformatted text blocks', async () => {
		await expect(
			parseScenarioHTML(`
				<scenario id="duplicate-pre">
					<run>
						<bt-send id="send" task="reader">
							<pre>one</pre>
							<pre>two</pre>
						</bt-send>
					</run>
				</scenario>
			`),
		).rejects.toThrow('<bt-send> can contain at most one <pre>')
	})

	it('rejects unsupported top-level scenario sections', async () => {
		await expect(
			parseScenarioHTML(`
				<scenario id="invalid-section">
					<run></run>
					<surprise></surprise>
				</scenario>
			`),
		).rejects.toThrow('unsupported <scenario> child <surprise>')
	})

	it('rejects unsupported operations in run sections', async () => {
		await expect(
			parseScenarioHTML(`
				<scenario id="invalid-operation">
					<run>
						<bt-dance id="dance"></bt-dance>
					</run>
				</scenario>
			`),
		).rejects.toThrow('<run> cannot contain <bt-dance>')
	})

	it('rejects operation children that would be ignored', async () => {
		await expect(
			parseScenarioHTML(`
				<scenario id="invalid-operation-child">
					<run>
						<bt-send id="send" task="worker">
							<script>console.log('ignored')</script>
						</bt-send>
					</run>
				</scenario>
			`),
		).rejects.toThrow('<bt-send> cannot contain <script>')
	})

	it('rejects unsupported assertion children', async () => {
		await expect(
			parseScenarioHTML(`
				<scenario id="invalid-assertion-child">
					<run></run>
					<then>
						<expect-step step="ready">
							<unexpected></unexpected>
						</expect-step>
					</then>
				</scenario>
			`),
		).rejects.toThrow('<expect-step> cannot contain <unexpected>')
	})

	it('parses tmux setup fixtures with child scripts', async () => {
		const scenario = await parseScenarioHTML(`
			<scenario id="fixture-script">
				<setup>
					<tmux-task-fixture id="stale" keep-alive="false" last-activity-age-ms="1000">
						<script>await new Promise(() => undefined)</script>
					</tmux-task-fixture>
				</setup>
				<run></run>
			</scenario>
		`)

		expect(scenario.setup[0]).toMatchObject({
			type: 'tmux-task-fixture',
			id: 'stale',
			attributes: { keepAlive: false, lastActivityAgeMs: 1000 },
		})
		expect(scenario.setup[0]?.script?.source).toBe('await new Promise(() => undefined)')
	})

	it('rejects unsupported setup fixtures', async () => {
		await expect(
			parseScenarioHTML(`
				<scenario id="invalid-fixture">
					<setup>
						<unknown-fixture></unknown-fixture>
					</setup>
					<run></run>
				</scenario>
			`),
		).rejects.toThrow('<setup> cannot contain <unknown-fixture>')
	})

	it('rejects tmux setup fixtures without child scripts', async () => {
		await expect(
			parseScenarioHTML(`
				<scenario id="missing-fixture-script">
					<setup>
						<tmux-task-fixture id="stale"></tmux-task-fixture>
					</setup>
					<run></run>
				</scenario>
			`),
		).rejects.toThrow('<tmux-task-fixture> requires exactly one <script>')
	})
})
