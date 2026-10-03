import { describe, test, expect } from 'bun:test'
import * as testing from '../testing.js'

describe('@empyria/restate/testing', () => {
	test('exports the fakes agent tests need, without loading the AI SDK', () => {
		expect(Object.keys(testing).sort()).toEqual([
			'fakeCtx',
			'sequence',
			'textResult',
			'toolCallResult',
		])
		const ctx = testing.fakeCtx()
		ctx.console.log('a', 'b')
		expect(ctx.logs).toEqual(['a b'])
	})
})
