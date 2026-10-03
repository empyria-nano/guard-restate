import { describe, test, expect } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { TerminalError, RetryableError } from '@restatedev/restate-sdk'
import { APICallError } from '@ai-sdk/provider'
import { runAgentLoop } from '../../lib/agent/Loop.js'
import { DEFAULT_LLM_RETRY } from '../../lib/agent/Errors.js'
import { fakeCtx, textResult, toolCallResult, sequence } from './fakes.js'

const echoTool = {
	description: 'Echo the input',
	inputSchema: { type: 'object', properties: { v: { type: 'string' } } },
	execute: async ({ v }) => ({ echoed: v }),
}

const apiError = (statusCode, isRetryable, responseHeaders) =>
	new APICallError({
		message: `status ${statusCode}`,
		url: 'https://llm.example/v1/chat/completions',
		requestBodyValues: {},
		statusCode,
		isRetryable,
		responseHeaders,
	})

describe('runAgentLoop', () => {
	test('returns the text answer and records each LLM call as its own step', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({ doGenerate: textResult('hi') })

		const result = await runAgentLoop(ctx, { model, system: '', prompt: 'hello' })

		expect(result).toMatchObject({ text: 'hi', steps: 1 })
		expect(result.messages[0]).toEqual({ role: 'user', content: 'hello' })
		expect(ctx.steps.map((s) => s.name)).toEqual(['llm-step-0'])
	})

	test('applies DEFAULT_LLM_RETRY by default, and a caller override', async () => {
		const model = new MockLanguageModelV4({ doGenerate: textResult('hi') })
		const ctx = fakeCtx()
		await runAgentLoop(ctx, { model, system: '', prompt: 'hello' })
		expect(ctx.steps[0].options).toBe(DEFAULT_LLM_RETRY)

		const retry = { maxRetryAttempts: 1 }
		const ctx2 = fakeCtx()
		await runAgentLoop(ctx2, { model, system: '', prompt: 'hello', retry })
		expect(ctx2.steps[0].options).toBe(retry)
	})

	test('a non-retryable model failure is terminal', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: () => {
				throw apiError(401, false)
			},
		})
		await expect(
			runAgentLoop(fakeCtx(), { model, system: '', prompt: 'hello' }),
		).rejects.toThrow(TerminalError)
	})

	test('a rate-limited model failure with Retry-After becomes a RetryableError', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: () => {
				throw apiError(429, true, { 'retry-after': '5' })
			},
		})
		let caught
		try {
			await runAgentLoop(fakeCtx(), { model, system: '', prompt: 'hello', retry: {} })
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(RetryableError)
		expect(caught.retryAfter).toEqual({ seconds: 5 })
	})

	test('runs a tool, feeds its result back, and continues', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({
			doGenerate: sequence(
				toolCallResult([{ toolName: 'echo', input: { v: 'x' } }]),
				textResult('done'),
			),
		})

		const result = await runAgentLoop(ctx, {
			model,
			system: '',
			prompt: 'hello',
			tools: { echo: echoTool },
		})

		expect(result).toMatchObject({ text: 'done', steps: 2 })
		expect(ctx.steps.map((s) => s.name)).toEqual(['llm-step-0', 'tool:echo-0.0', 'llm-step-1'])
		expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('echoed')
	})

	test('exceeding maxSteps is terminal', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: toolCallResult([{ toolName: 'echo', input: { v: 'x' } }]),
		})
		await expect(
			runAgentLoop(fakeCtx(), {
				model,
				system: '',
				prompt: 'hello',
				tools: { echo: echoTool },
				maxSteps: 1,
			}),
		).rejects.toThrow(/maxSteps/)
	})

	test('exceeding maxTokens is terminal with code 429', async () => {
		const model = new MockLanguageModelV4({ doGenerate: textResult('hi') })
		let caught
		try {
			await runAgentLoop(fakeCtx(), { model, system: '', prompt: 'hello', maxTokens: 1 })
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(TerminalError)
		expect(caught.code).toBe(429)
	})

	test('puts only the skill index in the system prompt', async () => {
		const model = new MockLanguageModelV4({ doGenerate: textResult('ok') })
		await runAgentLoop(fakeCtx(), {
			model,
			system: 'Be terse.',
			prompt: 'hello',
			skills: [{ name: 'summarise', description: 'Summarise things' }],
		})
		const sent = JSON.stringify(model.doGenerateCalls[0].prompt)
		expect(sent).toContain('Be terse.')
		expect(sent).toContain('summarise: Summarise things')
	})

	test('with an outputSchema, nudges a plain-text answer and returns final_answer’s input', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({
			doGenerate: sequence(
				textResult('here you go'),
				toolCallResult([{ toolName: 'final_answer', input: { score: 7 } }]),
			),
		})

		const result = await runAgentLoop(ctx, {
			model,
			system: '',
			prompt: 'rate it',
			outputSchema: { type: 'object', properties: { score: { type: 'number' } } },
		})

		expect(result).toMatchObject({ output: { score: 7 }, steps: 2 })
		expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('final_answer')
	})

	test('prepends loadHistory’s messages to every model call, without journaling them', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({ doGenerate: textResult('ok') })
		const history = [{ role: 'user', content: 'EARLIER TURN' }]

		const result = await runAgentLoop(ctx, {
			model,
			system: '',
			prompt: 'hello',
			loadHistory: async () => history,
		})

		expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain('EARLIER TURN')
		expect(JSON.stringify(ctx.steps[0].result)).not.toContain('EARLIER TURN')
		expect(JSON.stringify(result.messages)).not.toContain('EARLIER TURN')
	})
})

describe('runAgentLoop: step metadata and trace', () => {
	test('journals small per-step facts, returns a trace and logs one line per step', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({
			doGenerate: sequence(
				toolCallResult([{ toolName: 'echo', input: { v: 'a' } }]),
				textResult('done'),
			),
		})

		const result = await runAgentLoop(ctx, {
			model,
			system: '',
			prompt: 'go',
			tools: { echo: echoTool },
		})

		const meta = ctx.steps[0].result.meta
		expect(meta).toMatchObject({ model: 'mock-model-id', finishReason: 'tool-calls' })
		expect(meta.durationMs).toBeGreaterThanOrEqual(0)
		expect(result.trace).toHaveLength(2)
		expect(result.trace[0]).toMatchObject({
			step: 0,
			tools: ['echo'],
			finishReason: 'tool-calls',
		})
		expect(result.trace[1]).toMatchObject({ step: 1, tools: [], finishReason: 'stop' })
		expect(ctx.logs).toHaveLength(2)
		expect(ctx.logs[0]).toContain('llm-step-0')
		expect(ctx.logs[0]).toContain('tools=[echo]')
	})

	test('the journaled meta carries no prompt or reply text', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({ doGenerate: textResult('secret reply') })
		await runAgentLoop(ctx, { model, system: 'secret system', prompt: 'secret prompt' })
		const meta = JSON.stringify(ctx.steps[0].result.meta)
		expect(meta).not.toContain('secret')
	})

	test('works with a context that has no console', async () => {
		const ctx = { ...fakeCtx(), console: undefined }
		const model = new MockLanguageModelV4({ doGenerate: textResult('hi') })
		expect((await runAgentLoop(ctx, { model, system: '', prompt: 'x' })).text).toBe('hi')
	})
})
