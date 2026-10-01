import { describe, test, expect } from 'bun:test'
import { CancelledError, TerminalError, TimeoutError, serde } from '@restatedev/restate-sdk'
import { assertToolSpecs, executeTool } from '../../lib/agent/Tools.js'
import { DEFAULT_TOOL_RETRY } from '../../lib/agent/Errors.js'
import { hashSkill } from '../../lib/agent/Skills.js'
import { fakeCtx } from './fakes.js'

const schema = { type: 'object' }
const call = (toolName, input = {}) => ({ toolCallId: 'call_0', toolName, input })
const at = { step: 2, index: 1 }

describe('assertToolSpecs', () => {
	test('accepts block and execute tools', () => {
		expect(() =>
			assertToolSpecs({
				a: { description: 'a', inputSchema: schema, block: 'Svc', handler: 'do' },
				b: { description: 'b', inputSchema: schema, execute: async () => 1 },
			}),
		).not.toThrow()
	})

	test.each([
		[
			'a reserved name',
			{ final_answer: { description: 'x', inputSchema: schema, execute() {} } },
		],
		['an invalid name', { 'a b': { description: 'x', inputSchema: schema, execute() {} } }],
		['no inputSchema', { a: { description: 'x', execute() {} } }],
		[
			'both block and execute',
			{
				a: {
					description: 'x',
					inputSchema: schema,
					block: 'S',
					handler: 'h',
					execute() {},
				},
			},
		],
		['a block without handler', { a: { description: 'x', inputSchema: schema, block: 'S' } }],
		[
			'approval without notify',
			{
				a: {
					description: 'x',
					inputSchema: schema,
					execute() {},
					approval: { timeout: 10 },
				},
			},
		],
	])('rejects %s', (_, tools) => {
		expect(() => assertToolSpecs(tools)).toThrow(TypeError)
	})
})

describe('executeTool', () => {
	test('execute tool: own bounded step, with an idempotency key', async () => {
		const ctx = fakeCtx()
		let meta
		const tools = {
			write: {
				description: 'w',
				inputSchema: schema,
				execute: async (args, m) => {
					meta = m
					return { wrote: args.v }
				},
			},
		}

		const output = await executeTool(ctx, call('write', { v: 1 }), { tools, ...at })

		expect(output).toEqual({ type: 'json', value: { wrote: 1 } })
		expect(meta).toEqual({ idempotencyKey: 'inv-1:2.1' })
		expect(ctx.steps[0]).toMatchObject({ name: 'tool:write-2.1', options: DEFAULT_TOOL_RETRY })
	})

	test('execute tool: exhausted retries reach the model as error-text', async () => {
		const tools = {
			flaky: {
				description: 'f',
				inputSchema: schema,
				execute: async () => {
					throw new Error('connection reset')
				},
			},
		}
		const output = await executeTool(fakeCtx(), call('flaky'), { tools, ...at })
		expect(output).toEqual({ type: 'error-text', value: 'connection reset' })
	})

	test('execute tool without a retry limit: a transient error propagates, so Restate retries', async () => {
		const tools = {
			flaky: {
				description: 'f',
				inputSchema: schema,
				retry: {},
				execute: async () => {
					throw new Error('connection reset')
				},
			},
		}
		await expect(executeTool(fakeCtx(), call('flaky'), { tools, ...at })).rejects.toThrow(
			'connection reset',
		)
	})

	test('block tool: a Restate call to the target handler', async () => {
		const ctx = fakeCtx({ onCall: () => ({ id: 'ISS-1' }) })
		const tools = {
			lookup: {
				description: 'l',
				inputSchema: schema,
				block: { name: 'IssuerService' },
				handler: 'get',
				key: (args) => args.isin,
			},
		}

		const output = await executeTool(ctx, call('lookup', { isin: 'CH01' }), { tools, ...at })

		expect(output).toEqual({ type: 'json', value: { id: 'ISS-1' } })
		expect(ctx.calls[0]).toEqual({
			service: 'IssuerService',
			method: 'get',
			key: 'CH01',
			parameter: { isin: 'CH01' },
			inputSerde: serde.json,
			outputSerde: serde.json,
		})
		expect(ctx.steps).toEqual([])
	})

	test('block tool: a terminal error from the callee reaches the model as error-text', async () => {
		const ctx = fakeCtx({
			onCall: () => {
				throw new TerminalError('issuer not found')
			},
		})
		const tools = {
			lookup: {
				description: 'l',
				inputSchema: schema,
				block: 'IssuerService',
				handler: 'get',
			},
		}
		expect(await executeTool(ctx, call('lookup'), { tools, ...at })).toEqual({
			type: 'error-text',
			value: 'issuer not found',
		})
	})

	test('cancellation always propagates', async () => {
		const ctx = fakeCtx({
			onCall: () => {
				throw new CancelledError()
			},
		})
		const tools = {
			lookup: {
				description: 'l',
				inputSchema: schema,
				block: 'IssuerService',
				handler: 'get',
			},
		}
		await expect(executeTool(ctx, call('lookup'), { tools, ...at })).rejects.toBeInstanceOf(
			CancelledError,
		)
	})

	test('unknown tool reaches the model as error-text', async () => {
		expect(await executeTool(fakeCtx(), call('nope'), { tools: {}, ...at })).toEqual({
			type: 'error-text',
			value: 'Unknown tool "nope".',
		})
	})

	test('load_skill journals only a reference and hash, never the body', async () => {
		const ctx = fakeCtx()
		const loadSkill = async (name) => (name === 'summarise' ? 'FULL BODY' : undefined)
		const skillRef = { name: 'summarise', sha256: hashSkill('FULL BODY') }

		expect(
			await executeTool(ctx, call('load_skill', { name: 'summarise' }), {
				tools: {},
				loadSkill,
				...at,
			}),
		).toEqual({ type: 'json', value: { skillRef } })
		expect(ctx.steps[0]).toMatchObject({ name: 'skill:summarise-2.1', result: skillRef })

		expect(
			await executeTool(ctx, call('load_skill', { name: 'other' }), {
				tools: {},
				loadSkill,
				...at,
			}),
		).toEqual({ type: 'error-text', value: 'No skill named "other" is available.' })
	})

	describe('approval', () => {
		const approvalTools = (executed) => ({
			notifyDesk: {
				description: 'n',
				inputSchema: schema,
				execute: async () => {
					executed.push(true)
					return 'sent'
				},
				approval: { timeout: 1000, notify: { block: 'ApprovalInbox', handler: 'request' } },
			},
		})

		test('notifies the approver with the awakeable ID, then runs the tool once approved', async () => {
			const executed = []
			let waited
			const ctx = fakeCtx({
				onApproval: (timeout) => {
					waited = timeout
					return { approved: true }
				},
			})

			const output = await executeTool(ctx, call('notifyDesk', { msg: 'hi' }), {
				tools: approvalTools(executed),
				...at,
			})

			expect(output).toEqual({ type: 'json', value: 'sent' })
			expect(executed).toHaveLength(1)
			expect(waited).toBe(1000)
			expect(ctx.sends[0]).toMatchObject({
				service: 'ApprovalInbox',
				method: 'request',
				parameter: {
					awakeableId: 'awk-1',
					tool: 'notifyDesk',
					input: { msg: 'hi' },
					invocationId: 'inv-1',
				},
			})
		})

		test('a rejection skips the tool and tells the model why', async () => {
			const executed = []
			const ctx = fakeCtx({ onApproval: () => ({ approved: false, reason: 'not today' }) })
			const output = await executeTool(ctx, call('notifyDesk'), {
				tools: approvalTools(executed),
				...at,
			})
			expect(output).toEqual({
				type: 'error-text',
				value: 'Tool "notifyDesk" was not approved: not today.',
			})
			expect(executed).toHaveLength(0)
		})

		test('a timeout counts as a rejection', async () => {
			const executed = []
			const ctx = fakeCtx({
				onApproval: () => {
					throw new TimeoutError()
				},
			})
			const output = await executeTool(ctx, call('notifyDesk'), {
				tools: approvalTools(executed),
				...at,
			})
			expect(output.value).toContain('approval timed out')
			expect(executed).toHaveLength(0)
		})
	})
})
