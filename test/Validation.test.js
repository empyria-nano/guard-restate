import { describe, test, expect } from 'bun:test'
import { withValidation } from '../lib/Validation.js'
import { PrincipiaError } from '@principia/common'

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

describe('withValidation', () => {
	test('validates input and output, and returns the validated output', async () => {
		const handler = withValidation(inputSchema, outputSchema, async (ctx, input) => ({
			greeting: `Hello, ${input.name}`,
		}))
		const result = await handler({}, { name: 'Bob' })
		expect(result).toEqual({ greeting: 'Hello, Bob' })
	})

	test('throws when the input does not match the schema', async () => {
		const handler = withValidation(inputSchema, outputSchema, async () => ({ greeting: 'hi' }))
		await expect(handler({}, {})).rejects.toThrow(PrincipiaError)
	})

	test('throws when the handler output does not match the schema', async () => {
		const handler = withValidation(inputSchema, outputSchema, async () => ({ wrong: true }))
		await expect(handler({}, { name: 'Bob' })).rejects.toThrow(PrincipiaError)
	})
})
