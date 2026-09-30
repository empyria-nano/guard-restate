import { describe, test, expect } from 'bun:test'
import { TerminalError } from '@restatedev/restate-sdk'
import { withValidation } from '../lib/Validation.js'

const inputSchema = {
	type: 'object',
	properties: { name: { type: 'string' } },
	required: ['name'],
}
const outputSchema = {
	type: 'object',
	properties: { greeting: { type: 'string' } },
	required: ['greeting'],
}

const rejection = async (promise) => {
	try {
		await promise
	} catch (e) {
		return e
	}
	throw new Error('expected a rejection')
}

describe('withValidation', () => {
	test('validates input and output, and returns the validated output', async () => {
		const handler = withValidation(inputSchema, outputSchema, async (ctx, input) => ({
			greeting: `Hello, ${input.name}`,
		}))
		const result = await handler({}, { name: 'Bob' })
		expect(result).toEqual({ greeting: 'Hello, Bob' })
	})

	test('throws a 400 TerminalError when the input does not match the schema', async () => {
		let called = false
		const handler = withValidation(inputSchema, outputSchema, async () => {
			called = true
			return { greeting: 'hi' }
		})
		const e = await rejection(handler({}, {}))
		expect(e).toBeInstanceOf(TerminalError)
		expect(e.code).toBe(400)
		expect(e.metadata.validation).toBe('input')
		expect(called).toBe(false)
	})

	test('throws a 500 TerminalError when the handler output does not match the schema', async () => {
		const handler = withValidation(inputSchema, outputSchema, async () => ({ wrong: true }))
		const e = await rejection(handler({}, { name: 'Bob' }))
		expect(e).toBeInstanceOf(TerminalError)
		expect(e.code).toBe(500)
		expect(e.metadata.validation).toBe('output')
	})

	test('leaves errors thrown by the handler itself retryable', async () => {
		const boom = new Error('transient')
		const handler = withValidation(inputSchema, outputSchema, async () => {
			throw boom
		})
		const e = await rejection(handler({}, { name: 'Bob' }))
		expect(e).toBe(boom)
		expect(e).not.toBeInstanceOf(TerminalError)
	})
})
