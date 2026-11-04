import { describe, expect, test } from 'bun:test'
import * as restate from '@restatedev/restate-sdk'
import { createEndpointHandler } from '@restatedev/restate-sdk/fetch'
import { defineObject, defineService, defineWorkflow } from '../lib/Admin.js'
import { handlerContract, withValidation } from '../lib/Validation.js'

const input = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	title: 'In',
	type: 'object',
	required: ['name'],
	properties: { name: { type: 'string' } },
}
const output = {
	title: 'Out',
	type: 'object',
	required: ['greeting'],
	properties: { greeting: { type: 'string' } },
}
const greet = async (ctx, { name }) => ({ greeting: `Hello, ${name}` })
const validated = (options) => withValidation(input, output, greet, options)

/** What Restate receives about a definition: the SDK's real discovery answer, not its internals. */
const discovered = async (definition) => {
	const endpoint = createEndpointHandler({ services: [definition], bidirectional: false })
	const answer = await endpoint(
		new Request('http://endpoint/discover', {
			headers: { accept: 'application/vnd.restate.endpointmanifest.v4+json' },
		}),
	)
	return (await answer.json()).services[0]
}
const handlerOf = async (definition, name) =>
	(await discovered(definition)).handlers.find((handler) => handler.name === name)

describe('withValidation declares a contract', () => {
	test('its schemas and description, and only when it has a description', () => {
		expect(handlerContract(validated())).toEqual({ input, output })
		expect(handlerContract(validated({ description: 'Greets' }))).toEqual({
			input,
			output,
			description: 'Greets',
		})
	})

	test('any other function has none', () => {
		expect(handlerContract(greet)).toBeUndefined()
		expect(handlerContract(undefined)).toBeUndefined()
	})

	test('it does not show up as a property of the function', () => {
		expect(Object.keys(validated())).toEqual([])
	})
})

describe('define* publishes the contract', () => {
	const cases = [
		[
			'defineWorkflow',
			() => defineWorkflow({ name: 'W', handlers: { run: validated() } }),
			'run',
		],
		['defineService', () => defineService({ name: 'S', handlers: { go: validated() } }), 'go'],
		['defineObject', () => defineObject({ name: 'O', handlers: { go: validated() } }), 'go'],
	]

	for (const [name, make, handler] of cases) {
		test(`${name}: the whole schemas, unchanged`, async () => {
			const published = await handlerOf(make(), handler)
			expect(published.input.jsonSchema).toEqual(input)
			expect(published.output.jsonSchema).toEqual(output)
			expect(published.input.contentType).toBe('application/json')
		})
	}

	test('the description goes with the handler', async () => {
		const definition = defineService({
			name: 'S',
			handlers: { go: validated({ description: 'Greets' }) },
		})
		expect((await handlerOf(definition, 'go')).documentation).toBe('Greets')
	})

	test('the definition’s own description and metadata stay', async () => {
		const service = await discovered(
			defineWorkflow({
				name: 'W',
				description: 'A workflow',
				metadata: { version: '1.2.3' },
				handlers: { run: validated() },
			}),
		)
		expect(service.documentation).toBe('A workflow')
		expect(service.metadata).toEqual({ version: '1.2.3' })
	})
})

describe('no handler changes kind or behaviour', () => {
	const kindOf = async (definition, name) => (await handlerOf(definition, name)).ty

	test('a workflow: `run` is the main handler, the others shared, like plain functions', async () => {
		const definition = defineWorkflow({
			name: 'W',
			handlers: { run: validated(), status: validated() },
		})
		expect(await kindOf(definition, 'run')).toBe('WORKFLOW')
		expect(await kindOf(definition, 'status')).toBe('SHARED')
		const plain = defineWorkflow({ name: 'P', handlers: { run: greet, status: greet } })
		expect(await kindOf(plain, 'run')).toBe('WORKFLOW')
		expect(await kindOf(plain, 'status')).toBe('SHARED')
	})

	test('a service and an object, like plain functions', async () => {
		const kinds = async (define) => [
			await kindOf(define({ name: 'A', handlers: { go: validated() } }), 'go'),
			await kindOf(define({ name: 'B', handlers: { go: greet } }), 'go'),
		]
		const [validatedService, plainService] = await kinds(defineService)
		expect(validatedService).toBe(plainService)
		expect(await kinds(defineObject)).toEqual(['EXCLUSIVE', 'EXCLUSIVE'])
	})

	test('a handler the author wrapped stays what they made it', async () => {
		const published = await handlerOf(
			defineObject({
				name: 'O',
				handlers: { look: restate.handlers.object.shared(validated()) },
			}),
			'look',
		)
		expect(published.ty).toBe('SHARED')
		expect(published.input.jsonSchema).toBeUndefined()
	})

	test('a plain function publishes nothing', async () => {
		const published = await handlerOf(
			defineService({ name: 'S', handlers: { go: greet } }),
			'go',
		)
		expect(published.input.jsonSchema).toBeUndefined()
		expect(published.output.jsonSchema).toBeUndefined()
	})

	test('a definition with its own serde keeps it: its handlers may not speak JSON', async () => {
		const published = await handlerOf(
			defineService({
				name: 'S',
				handlers: { go: validated() },
				options: { serde: restate.serde.binary },
			}),
			'go',
		)
		expect(published.input.contentType).toBe('application/octet-stream')
		expect(published.input.jsonSchema).toBeUndefined()
	})

	test('it stays callable as a plain function, still validating', async () => {
		const definition = defineService({ name: 'S', handlers: { go: validated() } })
		expect(await definition.service.go({}, { name: 'Bob' })).toEqual({ greeting: 'Hello, Bob' })
		await expect(definition.service.go({}, {})).rejects.toMatchObject({ code: 400 })
	})

	test('the definition passed in is not changed', () => {
		const handlers = { go: validated() }
		const original = handlers.go
		defineService({ name: 'S', handlers })
		expect(handlers.go).toBe(original)
	})
})
