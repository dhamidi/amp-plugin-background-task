import { readFile } from 'node:fs/promises'
import type { BackgroundTaskAction } from '../background-task-manager'

export type ScenarioAction = BackgroundTaskAction | 'runner-restart'

export type ExpectedScenarioStatus = 'pass' | 'fail' | 'skip'

export interface Scenario {
	filePath: string
	id: string
	expected: ExpectedScenarioStatus
	reason: string | null
	summary: string
	defaults: Record<string, unknown>
	setup: ScenarioFixture[]
	run: ScenarioOperation[]
	assertions: ScenarioAssertion[]
	cleanup: ScenarioOperation[]
}

export interface ScenarioFixture {
	type: string
	id: string | null
	attributes: Record<string, unknown>
	script: ScenarioScript | null
}

export interface ScenarioOperation {
	action: ScenarioAction
	tagName: string
	id: string
	taskAlias: string | null
	attributes: Record<string, unknown>
	script: ScenarioScript | null
	text: string
	keys: string[]
	matchers: TextMatcher[]
	notifications: Record<string, unknown> | null
}

export interface ScenarioScript {
	type: 'javascript'
	source: string
}

export type MatcherKind = 'contains' | 'not-contains' | 'equals' | 'matches' | 'exists'

export interface TextMatcher {
	kind: MatcherKind
	value: string
	flags: string
	whitespace: 'normalize' | 'preserve'
}

export interface ScenarioAssertion {
	type: 'expect-step' | 'expect-task' | 'expect-output' | 'expect-notification'
	attributes: Record<string, unknown>
	step: string | null
	taskAlias: string | null
	matchers: TextMatcher[]
	fields: FieldAssertion[]
}

export interface FieldAssertion {
	name: string
	update: 'auto' | null
	matchers: TextMatcher[]
}

interface ElementNode {
	kind: 'element'
	tagName: string
	attributes: Record<string, string>
	children: ScenarioNode[]
}

interface TextNode {
	kind: 'text'
	text: string
}

type ScenarioNode = ElementNode | TextNode

const operationActions = {
	'bt-start': 'start',
	'bt-send': 'send',
	'bt-snapshot': 'snapshot',
	'bt-wait': 'wait',
	'bt-configure-notifications': 'configure_notifications',
	'bt-resize': 'resize',
	'bt-stop': 'stop',
	'bt-list': 'list',
	'runner-restart': 'runner-restart',
} satisfies Record<string, ScenarioAction>

const matcherTags = new Set(['contains', 'not-contains', 'equals', 'matches', 'exists'])
const voidTags = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
])
const explicitSelfClosingTags = [
	'defaults',
	'bt-list',
	'bt-snapshot',
	'bt-wait',
	'bt-resize',
	'bt-stop',
	'runner-restart',
	'expect-step',
	'expect-task',
	'expect-output',
	'expect-notification',
	'field',
	'contains',
	'not-contains',
	'equals',
	'matches',
	'exists',
	'notifications',
	'trigger',
]

export async function parseScenarioFile(filePath: string): Promise<Scenario> {
	return parseScenarioHTML(await readFile(filePath, 'utf8'), filePath)
}

export async function parseScenarioHTML(html: string, filePath = '<inline>'): Promise<Scenario> {
	const root = await parseHTMLTree(expandSelfClosingScenarioTags(html))
	const scenarioNodes = directChildElements(root).filter((node) => node.tagName === 'scenario')
	if (scenarioNodes.length > 1) {
		throw structureError(filePath, 'expected exactly one <scenario> root element')
	}
	const scenarioNode = scenarioNodes[0]
	if (scenarioNode === undefined) {
		throw structureError(filePath, 'missing <scenario> root element')
	}
	validateScenarioStructure(scenarioNode, filePath)

	const scenarioAttributes = coerceAttributes(scenarioNode.attributes)
	const id = stringAttribute(scenarioAttributes, 'id') ?? scenarioIDFromPath(filePath)
	const expected = expectedStatus(scenarioAttributes.expected)
	const defaultsNode = childElement(scenarioNode, 'defaults')
	const summaryNode = childElement(scenarioNode, 'summary')
	const setupNode = childElement(scenarioNode, 'setup')
	const runNode = childElement(scenarioNode, 'run')
	const thenNode = childElement(scenarioNode, 'then')
	const cleanupNode = childElement(scenarioNode, 'cleanup')

	return {
		filePath,
		id,
		expected,
		reason: stringAttribute(scenarioAttributes, 'reason'),
		summary: summaryNode ? normalizeBlockText(textContent(summaryNode)) : '',
		defaults: defaultsNode ? coerceAttributes(defaultsNode.attributes) : {},
		setup: setupNode ? directChildElements(setupNode).map(parseFixture) : [],
		run: runNode ? parseOperations(runNode) : [],
		assertions: thenNode ? parseAssertions(thenNode) : [],
		cleanup: cleanupNode ? parseOperations(cleanupNode) : [],
	}
}

const scenarioSectionTags = new Set(['summary', 'defaults', 'setup', 'run', 'then', 'cleanup'])
const fixtureChildTags: Record<string, ReadonlySet<string>> = {
	'tmux-task-fixture': new Set(['script']),
}

const operationChildTags = {
	'bt-start': new Set(['script', 'notifications']),
	'bt-send': new Set(['key', 'pre']),
	'bt-snapshot': new Set<string>(),
	'bt-wait': matcherTags,
	'bt-configure-notifications': new Set(['notifications']),
	'bt-resize': new Set<string>(),
	'bt-stop': new Set<string>(),
	'bt-list': new Set<string>(),
	'runner-restart': new Set<string>(),
} satisfies Record<keyof typeof operationActions, ReadonlySet<string>>

function validateScenarioStructure(scenarioNode: ElementNode, filePath: string): void {
	const sectionCounts = new Map<string, number>()
	for (const child of directChildElements(scenarioNode)) {
		if (!scenarioSectionTags.has(child.tagName)) {
			throw structureError(filePath, `unsupported <scenario> child <${child.tagName}>`)
		}
		sectionCounts.set(child.tagName, (sectionCounts.get(child.tagName) ?? 0) + 1)
	}

	for (const [tagName, count] of sectionCounts) {
		if (count > 1) throw structureError(filePath, `duplicate <${tagName}> section`)
	}
	if (!sectionCounts.has('run')) throw structureError(filePath, 'missing <run> section')

	for (const section of directChildElements(scenarioNode)) {
		validateSectionStructure(section, filePath)
	}
}

function validateSectionStructure(section: ElementNode, filePath: string): void {
	if (section.tagName === 'summary' || section.tagName === 'defaults') {
		validateNoChildElements(section, filePath)
		return
	}
	if (section.tagName === 'setup') {
		validateSetupSection(section, filePath)
		return
	}
	if (section.tagName === 'run' || section.tagName === 'cleanup') {
		validateOperationSection(section, filePath)
		return
	}
	if (section.tagName === 'then') {
		validateAssertionSection(section, filePath)
	}
}

function validateSetupSection(section: ElementNode, filePath: string): void {
	for (const fixture of directChildElements(section)) {
		const allowedTags = fixtureChildTags[fixture.tagName]
		if (allowedTags === undefined) {
			throw structureError(filePath, `<setup> cannot contain <${fixture.tagName}>`)
		}
		const scriptNodes = directChildElements(fixture).filter((child) => child.tagName === 'script')
		if (fixture.tagName === 'tmux-task-fixture' && scriptNodes.length !== 1) {
			throw structureError(filePath, '<tmux-task-fixture> requires exactly one <script>')
		}
		for (const child of directChildElements(fixture)) {
			if (!allowedTags.has(child.tagName)) {
				throw structureError(filePath, `<${fixture.tagName}> cannot contain <${child.tagName}>`)
			}
			if (child.tagName === 'script') validateScriptElement(child, filePath)
		}
	}
}

function validateOperationSection(section: ElementNode, filePath: string): void {
	for (const child of directChildElements(section)) {
		if (!isOperationTag(child.tagName)) {
			throw structureError(filePath, `<${section.tagName}> cannot contain <${child.tagName}>`)
		}
		validateOperationChildren(child, filePath)
	}
}

function validateOperationChildren(operation: ElementNode, filePath: string): void {
	const allowedTags = operationChildTags[operation.tagName as keyof typeof operationChildTags]
	const preNodes = directChildElements(operation).filter((child) => child.tagName === 'pre')
	if (operation.tagName === 'bt-send' && preNodes.length > 1) {
		throw structureError(filePath, '<bt-send> can contain at most one <pre>')
	}
	for (const child of directChildElements(operation)) {
		if (!allowedTags.has(child.tagName)) {
			throw structureError(filePath, `<${operation.tagName}> cannot contain <${child.tagName}>`)
		}
		if (child.tagName === 'script') validateScriptElement(child, filePath)
		if (child.tagName === 'notifications') validateNotificationsElement(child, filePath)
		if (child.tagName === 'pre') validateNoChildElements(child, filePath)
	}
}

function validateAssertionSection(section: ElementNode, filePath: string): void {
	for (const child of directChildElements(section)) {
		if (!isAssertionType(child.tagName)) {
			throw structureError(filePath, `<then> cannot contain <${child.tagName}>`)
		}
		validateAssertionChildren(child, filePath)
	}
}

function validateAssertionChildren(assertion: ElementNode, filePath: string): void {
	for (const child of directChildElements(assertion)) {
		if (child.tagName !== 'field' && !matcherTags.has(child.tagName)) {
			throw structureError(filePath, `<${assertion.tagName}> cannot contain <${child.tagName}>`)
		}
		if (child.tagName === 'field') validateFieldElement(child, filePath)
	}
}

function validateFieldElement(field: ElementNode, filePath: string): void {
	for (const child of directChildElements(field)) {
		if (!matcherTags.has(child.tagName)) {
			throw structureError(filePath, '<field> can only contain matcher elements')
		}
	}
}

function validateScriptElement(script: ElementNode, filePath: string): void {
	validateNoChildElements(script, filePath)
	parseScript(script)
}

function validateNotificationsElement(notifications: ElementNode, filePath: string): void {
	for (const child of directChildElements(notifications)) {
		if (child.tagName !== 'trigger') {
			throw structureError(filePath, '<notifications> can only contain <trigger> elements')
		}
		validateNoChildElements(child, filePath)
	}
}

function validateNoChildElements(node: ElementNode, filePath: string): void {
	const child = directChildElements(node)[0]
	if (child !== undefined) {
		throw structureError(filePath, `<${node.tagName}> cannot contain <${child.tagName}>`)
	}
}

function structureError(filePath: string, message: string): Error {
	return new Error(`${filePath}: invalid scenario structure: ${message}`)
}

async function parseHTMLTree(html: string): Promise<ElementNode> {
	const root: ElementNode = { kind: 'element', tagName: '#root', attributes: {}, children: [] }
	const stack: ElementNode[] = [root]

	await new HTMLRewriter()
		.on('*', {
			element(element) {
				const node: ElementNode = {
					kind: 'element',
					tagName: element.tagName.toLowerCase(),
					attributes: Object.fromEntries(element.attributes),
					children: [],
				}
				currentNode(stack).children.push(node)
				if (voidTags.has(node.tagName)) return

				stack.push(node)
				element.onEndTag(() => {
					const popped = stack.pop()
					if (popped !== node) {
						throw new Error(`Unexpected HTML nesting while parsing <${node.tagName}>`)
					}
				})
			},
			text(text) {
				if (text.text.length === 0) return
				currentNode(stack).children.push({ kind: 'text', text: text.text })
			},
		})
		.transform(new Response(html))
		.text()

	return root
}

function currentNode(stack: readonly ElementNode[]): ElementNode {
	const node = stack.at(-1)
	if (node === undefined) throw new Error('HTML parser stack is empty')
	return node
}

function parseOperations(parent: ElementNode): ScenarioOperation[] {
	return directChildElements(parent)
		.filter((node) => isOperationTag(node.tagName))
		.map((node, index) => parseOperation(node, index))
}

function parseOperation(node: ElementNode, index: number): ScenarioOperation {
	if (!isOperationTag(node.tagName)) {
		throw new Error(`Unsupported operation tag <${node.tagName}>`)
	}
	const action = operationActions[node.tagName]

	const attributes = coerceAttributes(node.attributes)
	const id = stringAttribute(attributes, 'id') ?? `${action}-${index + 1}`
	const taskAlias = stringAttribute(attributes, 'task')
	const scriptNode = childElement(node, 'script')
	const notificationsNode = childElement(node, 'notifications')
	const inputAttributes = omitKeys(attributes, ['id', 'task'])

	return {
		action,
		tagName: node.tagName,
		id,
		taskAlias,
		attributes: inputAttributes,
		script: scriptNode ? parseScript(scriptNode) : null,
		text: parseOperationText(node),
		keys: directChildElements(node)
			.filter((child) => child.tagName === 'key')
			.map((child) => normalizeBlockText(textContent(child)))
			.filter((key) => key.length > 0),
		matchers: parseMatchers(node),
		notifications: notificationsNode ? parseNotifications(notificationsNode) : null,
	}
}

function parseOperationText(node: ElementNode): string {
	const preNode = childElement(node, 'pre')
	if (preNode !== undefined) return normalizeBlockText(textContent(preNode))
	return normalizeBlockText(directTextContent(node))
}

function parseFixture(node: ElementNode): ScenarioFixture {
	const attributes = coerceAttributes(node.attributes)
	const scriptNode = childElement(node, 'script')
	return {
		type: node.tagName,
		id: stringAttribute(attributes, 'id'),
		attributes: omitKeys(attributes, ['id']),
		script: scriptNode ? parseScript(scriptNode) : null,
	}
}

function parseAssertions(parent: ElementNode): ScenarioAssertion[] {
	return directChildElements(parent)
		.filter((node) => node.tagName.startsWith('expect-'))
		.map(parseAssertion)
}

function parseAssertion(node: ElementNode): ScenarioAssertion {
	if (!isAssertionType(node.tagName)) {
		throw new Error(`Unsupported assertion tag <${node.tagName}>`)
	}

	const attributes = coerceAttributes(node.attributes)
	return {
		type: node.tagName,
		attributes,
		step: stringAttribute(attributes, 'step'),
		taskAlias: stringAttribute(attributes, 'task'),
		matchers: parseMatchers(node),
		fields: directChildElements(node)
			.filter((child) => child.tagName === 'field')
			.map(parseFieldAssertion),
	}
}

function parseFieldAssertion(node: ElementNode): FieldAssertion {
	const attributes = coerceAttributes(node.attributes)
	const name = stringAttribute(attributes, 'name')
	if (name === null) throw new Error('<field> assertions require name="..."')
	return {
		name,
		update: attributes.update === 'auto' ? 'auto' : null,
		matchers: parseMatchers(node),
	}
}

function parseScript(node: ElementNode): ScenarioScript {
	const type = node.attributes.type ?? 'application/javascript'
	if (!['application/javascript', 'text/javascript', 'module'].includes(type)) {
		throw new Error(`<script> in scenarios must contain plain JavaScript, got type=${type}`)
	}
	return { type: 'javascript', source: normalizeBlockText(textContent(node)) }
}

function parseNotifications(node: ElementNode): Record<string, unknown> {
	const notifications = coerceAttributes(node.attributes)
	const triggers = directChildElements(node)
		.filter((child) => child.tagName === 'trigger')
		.map((child) => coerceAttributes(child.attributes))
	if (triggers.length > 0) notifications.triggers = triggers
	return notifications
}

function parseMatchers(node: ElementNode): TextMatcher[] {
	const matchers: TextMatcher[] = []
	const attributes = coerceAttributes(node.attributes)
	for (const kind of matcherTags) {
		const attributeName = kind === 'not-contains' ? 'notContains' : kind
		const value = attributes[attributeName]
		if (typeof value === 'string') {
			matchers.push({ kind: kind as MatcherKind, value, flags: '', whitespace: 'normalize' })
		}
	}

	for (const child of directChildElements(node)) {
		if (!matcherTags.has(child.tagName)) continue
		const attributes = coerceAttributes(child.attributes)
		const whitespace = attributes.whitespace === 'preserve' ? 'preserve' : 'normalize'
		const value =
			whitespace === 'preserve' ? textContent(child) : normalizeBlockText(textContent(child))
		matchers.push({
			kind: child.tagName as MatcherKind,
			value,
			flags: stringAttribute(attributes, 'flags') ?? '',
			whitespace,
		})
	}
	return matchers
}

function expandSelfClosingScenarioTags(html: string): string {
	return explicitSelfClosingTags.reduce(
		(current, tag) =>
			current.replace(
				new RegExp(`<(${tag})([^<>]*?)\\s/>`, 'gi'),
				(_match, tagName: string, attributes: string) => `<${tagName}${attributes}></${tagName}>`,
			),
		html,
	)
}

function isOperationTag(tagName: string): tagName is keyof typeof operationActions {
	return tagName in operationActions
}

function isAssertionType(tagName: string): tagName is ScenarioAssertion['type'] {
	return ['expect-step', 'expect-task', 'expect-output', 'expect-notification'].includes(tagName)
}

function childElement(node: ElementNode, tagName: string): ElementNode | undefined {
	return directChildElements(node).find((child) => child.tagName === tagName)
}

function directChildElements(node: ElementNode): ElementNode[] {
	return node.children.filter((child): child is ElementNode => child.kind === 'element')
}

function textContent(node: ElementNode): string {
	return node.children
		.map((child) => (child.kind === 'text' ? child.text : textContent(child)))
		.join('')
}

function directTextContent(node: ElementNode): string {
	return node.children.map((child) => (child.kind === 'text' ? child.text : '')).join('')
}

export function normalizeBlockText(value: string): string {
	const lines = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
	while (lines.length > 0 && lines[0]?.trim() === '') lines.shift()
	while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
	const indent = Math.min(
		...lines.filter((line) => line.trim().length > 0).map((line) => leadingWhitespaceLength(line)),
	)
	if (!Number.isFinite(indent)) return ''
	return lines.map((line) => line.slice(indent)).join('\n')
}

function leadingWhitespaceLength(value: string): number {
	return value.match(/^\s*/)?.[0].length ?? 0
}

function coerceAttributes(attributes: Record<string, string>): Record<string, unknown> {
	const output: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(attributes)) {
		output[kebabToCamel(key)] = coerceAttributeValue(value)
	}
	return output
}

function coerceAttributeValue(value: string): unknown {
	if (value === '' || value === 'true') return true
	if (value === 'false') return false
	if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
	return value
}

function kebabToCamel(value: string): string {
	return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function omitKeys(
	attributes: Record<string, unknown>,
	keys: readonly string[],
): Record<string, unknown> {
	const output: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(attributes)) {
		if (!keys.includes(key)) output[key] = value
	}
	return output
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | null {
	const value = attributes[key]
	return typeof value === 'string' ? value : null
}

function expectedStatus(value: unknown): ExpectedScenarioStatus {
	return value === 'fail' || value === 'skip' ? value : 'pass'
}

function scenarioIDFromPath(filePath: string): string {
	const name = filePath.split(/[\\/]/).at(-1) ?? 'scenario'
	return name.replace(/\.html?$/i, '')
}
