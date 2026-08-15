import { describe, test, expect } from 'bun:test'
import { CallerServiceDef } from '../lib/Caller.js'

describe('CallerServiceDef', () => {
	test('has the expected name and a single-attempt retry policy', () => {
		expect(CallerServiceDef.name).toBe('CallerService')
		expect(CallerServiceDef.options.retryPolicy.maxAttempts).toBe(1)
	})

	test('dispatch forwards the call to the target handler and returns its invocation ID', async () => {
		const ctx = {
			serviceSendClient: ({ name }) => {
				expect(name).toBe('TargetSvc')
				return {
					doThing: async (payload) => {
						expect(payload).toEqual({ a: 1 })
						return { invocationId: Promise.resolve('inv-123') }
					},
				}
			},
		}

		const result = await CallerServiceDef.handlers.dispatch(ctx, {
			name: 'TargetSvc',
			handler: 'doThing',
			payload: { a: 1 },
		})
		expect(result).toBe('inv-123')
	})

	test('throws when the handler is not a function on the target client', async () => {
		const ctx = { serviceSendClient: () => ({}) }

		await expect(
			CallerServiceDef.handlers.dispatch(ctx, {
				name: 'TargetSvc',
				handler: 'missing',
				payload: {},
			}),
		).rejects.toThrow(/missing.*is not a function/)
	})
})
