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
