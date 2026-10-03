import { describe, test, expect } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { TerminalError } from '@restatedev/restate-sdk'
import { createAgentService, defineAgent } from '../../lib/agent/Agent.js'
import { DEFAULT_AGENT_RETRY_POLICY } from '../../lib/agent/Errors.js'
import { env, fakeCtx, sequence, textResult, toolCallResult } from './fakes.js'

const okModel = () => new MockLanguageModelV4({ doGenerate: textResult('ok') })

describe('defineAgent: definition', () => {
	test('memory none → a service named after the agent, with the default retry policy', () => {
		const agent = defineAgent({ name: 'Triage', model: okModel() })
		expect(agent.name).toBe('Triage')
		expect(typeof agent.service.ask).toBe('function')
		expect(agent.options.retryPolicy).toEqual(DEFAULT_AGENT_RETRY_POLICY)
	})

	test('memory session → a virtual object with ask and reset', () => {
		const agent = defineAgent({ name: 'Chat', model: okModel(), memory: 'session' })
		expect(Object.keys(agent.object).sort()).toEqual(['ask', 'reset'])
	})

	test.each([
		['no name', { model: {} }],
		['no model or env', { name: 'A' }],
		['an unknown memory mode', { name: 'A', model: {}, memory: 'forever' }],
		['a historyStore without session memory', { name: 'A', model: {}, historyStore: {} }],
		['an invalid tool', { name: 'A', model: {}, tools: { load_skill: {} } }],
	])('rejects %s', (_, spec) => {
		expect(() => defineAgent(spec)).toThrow(TypeError)
	})

	test('builds the model from env when no model is given', () => {
		expect(() => defineAgent({ name: 'A', env })).not.toThrow()
	})
})

describe('defineAgent: ask', () => {
	test('invalid input is terminal', async () => {
		const agent = defineAgent({ name: 'A', model: okModel() })
		await expect(agent.service.ask(fakeCtx(), {})).rejects.toThrow(TerminalError)
		await expect(
			agent.service.ask(fakeCtx(), { prompt: 'hi', notAField: true }),
		).rejects.toThrow(TerminalError)
	})

	test('sends the caller’s prompt, not a value from loadContext', async () => {
		const model = new MockLanguageModelV4({ doGenerate: textResult('Sure.') })
		const agent = defineAgent({
			name: 'A',
			model,
			loadContext: async () => ({ systemPrompt: '', skills: [], prompt: 'HIJACKED' }),
		})

		expect(await agent.service.ask(fakeCtx(), { prompt: 'REAL PROMPT' })).toEqual({
			text: 'Sure.',
			steps: 1,
		})
		const sent = JSON.stringify(model.doGenerateCalls[0].prompt)
		expect(sent).toContain('REAL PROMPT')
		expect(sent).not.toContain('HIJACKED')
	})

	test('load-context journals the system prompt and skill index, never skill bodies', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({
			doGenerate: sequence(
				toolCallResult([{ toolName: 'load_skill', input: { name: 'summarise' } }]),
				textResult('ok'),
			),
		})
		const agent = defineAgent({
			name: 'A',
			model,
			system: 'Static.',
			loadContext: async () => ({
				systemPrompt: 'Be terse.',
				skills: [{ name: 'summarise', description: 'Summarise', body: 'SECRET BODY' }],
			}),
		})

		await agent.service.ask(ctx, { prompt: 'hi' })

		const loadContext = ctx.steps.find((s) => s.name === 'load-context')
		expect(loadContext.result).toEqual({
			systemPrompt: 'Be terse.',
			skills: [{ name: 'summarise', description: 'Summarise' }],
		})
		expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain('Static.\\n\\nBe terse.')
		expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('SECRET BODY')
		expect(JSON.stringify(ctx.steps.map((s) => s.result))).not.toContain('SECRET BODY')
	})

	test('a custom output schema returns final_answer’s arguments, validated', async () => {
		const output = {
			type: 'object',
			properties: { score: { type: 'number' } },
			required: ['score'],
			additionalProperties: false,
		}
		const answer = (input) =>
			defineAgent({
				name: 'A',
				output,
				model: new MockLanguageModelV4({
					doGenerate: toolCallResult([{ toolName: 'final_answer', input }]),
				}),
			}).service.ask(fakeCtx(), { prompt: 'rate' })

		expect(await answer({ score: 7 })).toEqual({ score: 7 })
		await expect(answer({ score: 'high' })).rejects.toThrow(TerminalError)
	})

	test('a custom input schema with a prompt builder', async () => {
		const model = okModel()
		const agent = defineAgent({
			name: 'A',
			model,
			input: { type: 'object', properties: { isin: { type: 'string' } }, required: ['isin'] },
			prompt: ({ isin }) => `Triage ${isin}`,
		})
		await agent.service.ask(fakeCtx(), { isin: 'CH0012' })
		expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain('Triage CH0012')
	})

	test('createAgentService keeps the old AgentService shape', async () => {
		const agent = createAgentService({ env, model: okModel() })
		expect(agent.name).toBe('AgentService')
		expect(await agent.service.ask(fakeCtx(), { prompt: 'hi' })).toEqual({
			text: 'ok',
			steps: 1,
		})
	})
})

describe('defineAgent: session memory', () => {
	test('without a store: later turns see earlier ones; reset forgets them', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: sequence(textResult('first answer'), textResult('second answer')),
		})
		const agent = defineAgent({ name: 'Chat', model, memory: 'session' })
		const ctx = fakeCtx({ key: 'thread-1' })

		await agent.object.ask(ctx, { prompt: 'first question' })
		await agent.object.ask(ctx, { prompt: 'second question' })

		const second = JSON.stringify(model.doGenerateCalls[1].prompt)
		expect(second).toContain('first question')
		expect(second).toContain('first answer')
		expect(ctx.state.history).toHaveLength(2)

		await agent.object.reset(ctx)
		expect(ctx.state.history).toBeUndefined()
	})

	test('without a store: keeps only the last maxHistoryTurns turns', async () => {
		const agent = defineAgent({
			name: 'Chat',
			model: okModel(),
			memory: 'session',
			limits: { maxHistoryTurns: 2 },
		})
		const ctx = fakeCtx({ key: 'thread-1' })
		for (const prompt of ['one', 'two', 'three']) await agent.object.ask(ctx, { prompt })

		expect(ctx.state.history).toHaveLength(2)
		expect(JSON.stringify(ctx.state.history)).not.toContain('"one"')
	})

	test('with a store: state and journal hold only the ref', async () => {
		const snapshots = new Map()
		const historyStore = {
			load: async (ref) => snapshots.get(ref),
			save: async (sessionKey, messages) => {
				const ref = `${sessionKey}@${snapshots.size + 1}`
				snapshots.set(ref, messages)
				return ref
			},
		}
		const model = new MockLanguageModelV4({
			doGenerate: sequence(textResult('first answer'), textResult('second answer')),
		})
		const agent = defineAgent({ name: 'Chat', model, memory: 'session', historyStore })
		const ctx = fakeCtx({ key: 'thread-1' })

		await agent.object.ask(ctx, { prompt: 'first question' })
		await agent.object.ask(ctx, { prompt: 'second question' })

		expect(ctx.state).toEqual({ historyRef: 'thread-1@2' })
		expect(snapshots.get('thread-1@2')).toHaveLength(4)
		expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('first answer')
		const journaled = JSON.stringify(ctx.steps.map((s) => s.result))
		expect(journaled).not.toContain('first question')
	})
})

describe('defineAgent: tools that depend on the request', () => {
	const ctxInput = {
		type: 'object',
		properties: { prompt: { type: 'string', minLength: 1 }, folder: { type: 'string' } },
		required: ['prompt', 'folder'],
	}

	test('a tools function receives the validated request and its tools are used', async () => {
		const seen = []
		const model = new MockLanguageModelV4({
			doGenerate: sequence(
				toolCallResult([{ toolName: 'where', input: {} }]),
				textResult('ok'),
			),
		})
		const agent = defineAgent({
			name: 'A',
			model,
			input: ctxInput,
			tools: (request) => {
				seen.push(request.folder)
				return {
					where: {
						description: 'Where am I',
						inputSchema: { type: 'object' },
						execute: async () => ({ folder: request.folder }),
					},
				}
			},
		})
		const ctx = fakeCtx()
		await agent.service.ask(ctx, { prompt: 'hi', folder: '/f' })
		expect(seen.length).toBeGreaterThan(0)
		expect(new Set(seen)).toEqual(new Set(['/f']))
		expect(ctx.steps.find((s) => s.name.startsWith('tool:where')).result).toEqual({
			folder: '/f',
		})
	})

	test('an invalid tools map for one request fails that request terminally (500)', async () => {
		const agent = defineAgent({
			name: 'A',
			model: okModel(),
			tools: () => ({ load_skill: { description: 'x', inputSchema: {} } }),
		})
		const error = await agent.service.ask(fakeCtx(), { prompt: 'hi' }).catch((e) => e)
		expect(error).toBeInstanceOf(TerminalError)
		expect(error.code).toBe(500)
	})
})

describe('defineAgent: respond and responseSchema', () => {
	test('respond shapes the return value from the loop result', async () => {
		const agent = defineAgent({
			name: 'A',
			model: okModel(),
			respond: (r, input) => ({
				answer: r.text,
				steps: r.steps,
				trace: r.trace.length,
				echoed: input.prompt,
			}),
			responseSchema: { type: 'object', required: ['answer'] },
		})
		expect(await agent.service.ask(fakeCtx(), { prompt: 'hi' })).toEqual({
			answer: 'ok',
			steps: 1,
			trace: 1,
			echoed: 'hi',
		})
	})

	test('a response that breaks responseSchema is terminal (500)', async () => {
		const agent = defineAgent({
			name: 'A',
			model: okModel(),
			respond: () => ({ nope: true }),
			responseSchema: { type: 'object', required: ['answer'] },
		})
		const error = await agent.service.ask(fakeCtx(), { prompt: 'hi' }).catch((e) => e)
		expect(error).toBeInstanceOf(TerminalError)
		expect(error.code).toBe(500)
	})

	test('without respond the default result is unchanged', async () => {
		expect(
			await defineAgent({ name: 'A', model: okModel() }).service.ask(fakeCtx(), {
				prompt: 'hi',
			}),
		).toEqual({ text: 'ok', steps: 1 })
	})

	test('rejects respond or label that is not a function', () => {
		expect(() => defineAgent({ name: 'A', model: okModel(), respond: 1 })).toThrow(TypeError)
		expect(() => defineAgent({ name: 'A', model: okModel(), label: 'x' })).toThrow(TypeError)
	})
})

describe('defineAgent: label', () => {
	test('prefixes a terminal failure with the label and keeps its code', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: toolCallResult([{ toolName: 'nope', input: {} }]),
		})
		const agent = defineAgent({
			name: 'A',
			model,
			limits: { maxSteps: 2 },
			label: (input) => `job ${input.prompt}`,
		})
		const error = await agent.service.ask(fakeCtx(), { prompt: 'J1' }).catch((e) => e)
		expect(error.constructor).toBe(TerminalError)
		expect(error.message).toStartWith('[job J1] ')
		expect(error.message).toContain('maxSteps')
	})

	test('leaves cancellations and non-terminal errors untouched', async () => {
		const { CancelledError } = await import('@restatedev/restate-sdk')
		const cancelled = new CancelledError()
		const plain = new Error('transient')
		for (const thrown of [cancelled, plain]) {
			const model = new MockLanguageModelV4({
				doGenerate: () => {
					throw thrown
				},
			})
			const agent = defineAgent({ name: 'A', model, label: () => 'L' })
			const ctx = fakeCtx()
			ctx.run = async () => {
				throw thrown
			}
			expect(await agent.service.ask(ctx, { prompt: 'hi' }).catch((e) => e)).toBe(thrown)
		}
	})
})

describe('defineAgent: request size cap', () => {
	test('refuses a request over limits.maxInputBytes (413), labelled when a label is set', async () => {
		const agent = defineAgent({
			name: 'A',
			model: okModel(),
			limits: { maxInputBytes: 50 },
			label: () => 'L',
		})
		const error = await agent.service
			.ask(fakeCtx(), { prompt: 'x'.repeat(200) })
			.catch((e) => e)
		expect(error).toBeInstanceOf(TerminalError)
		expect(error.code).toBe(413)
		expect(error.message).toStartWith('[L] ')
	})

	test('has a generous default', async () => {
		const agent = defineAgent({ name: 'A', model: okModel() })
		expect((await agent.service.ask(fakeCtx(), { prompt: 'x'.repeat(10_000) })).text).toBe('ok')
		const error = await agent.service
			.ask(fakeCtx(), { prompt: 'x'.repeat(70_000) })
			.catch((e) => e)
		expect(error.code).toBe(413)
	})
})
