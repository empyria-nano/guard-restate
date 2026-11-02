import { afterEach, describe, expect, test } from 'bun:test'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { MockLanguageModelV4 } from 'ai/test'
import { TerminalError } from '@restatedev/restate-sdk'
import { defineObject, defineService, defineWorkflow } from '../lib/Admin.js'
import { cronJob, cronJobInitiator } from '../lib/Cron.js'
import { genAiAttributes, runAgentLoop } from '../lib/agent/Loop.js'
import { fakeCtx, textResult } from './agent/fakes.js'
import {
	addSpanEvent,
	flushTelemetry,
	resetTelemetry,
	setSpanAttributes,
	startTelemetry,
	TRACING_HOOK,
	tracesEndpoint,
	withTracing,
} from '../lib/Telemetry.js'
import { withValidation } from '../lib/Validation.js'

afterEach(resetTelemetry)

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const PARENT_SPAN = '00f067aa0ba902b7'

/** What the SDK gives a hook on each attempt: the request with Restate's attempt headers (W3C trace context). */
const attempt = (target = 'Greeter/greet') =>
	TRACING_HOOK({
		request: {
			id: 'inv_1',
			target,
			attemptHeaders: new Map([['traceparent', `00-${TRACE_ID}-${PARENT_SPAN}-01`]]),
		},
	}).interceptor

const tracing = () => {
	const exporter = new InMemorySpanExporter()
	startTelemetry({ processor: new SimpleSpanProcessor(exporter) })
	return exporter
}

describe('tracesEndpoint', () => {
	test('off without an endpoint, or when the SDK is disabled', () => {
		expect(tracesEndpoint({})).toBeUndefined()
		expect(
			tracesEndpoint({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318',
				OTEL_SDK_DISABLED: 'true',
			}),
		).toBeUndefined()
	})

	test('the traces path is added to the general endpoint; the traces endpoint wins as it is', () => {
		expect(tracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318/' })).toBe(
			'http://c:4318/v1/traces',
		)
		expect(
			tracesEndpoint({
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318',
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t:4318/custom',
			}),
		).toBe('http://t:4318/custom')
	})
})

describe('withTracing', () => {
	const ON = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }

	test('off by default: without an endpoint the definition is left as it is', () => {
		const def = { name: 'S', handlers: {} }
		expect(withTracing(def, {})).toBe(def)
		expect(withTracing(def, { ...ON, OTEL_SDK_DISABLED: 'true' })).toBe(def)
	})

	test('a service can stay out while the rest is traced; the flag never reaches Restate', () => {
		const traced = withTracing({ name: 'S', handlers: {}, tracing: false }, ON)
		expect(traced).toEqual({ name: 'S', handlers: {} })
		expect(withTracing({ name: 'S', handlers: {}, tracing: true }, {})).toEqual({
			name: 'S',
			handlers: {},
		})
	})

	test('when on: the hook first, keeping the hooks a definition has, without changing it', () => {
		const own = () => ({})
		const def = {
			name: 'S',
			handlers: {},
			options: { hooks: [own], retryPolicy: { maxAttempts: 3 } },
		}
		const traced = withTracing(def, ON)
		expect(traced.options.hooks).toEqual([TRACING_HOOK, own])
		expect(traced.options.retryPolicy).toEqual({ maxAttempts: 3 })
		expect(def.options.hooks).toEqual([own])
	})

	test('adding it twice has no effect', () => {
		const once = withTracing({ name: 'S', handlers: {} }, ON)
		expect(withTracing(once, ON)).toBe(once)
	})

	test('the definitions this package builds carry it only when tracing is on, and handlers stay where they were', () => {
		const handlers = { run: async () => 'ok' }
		const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
		try {
			delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
			expect(defineService({ name: 'S', handlers }).options?.hooks).toBeUndefined()
			expect(cronJob.options?.hooks).toBeUndefined() // defined at import, with tracing off
			expect(cronJobInitiator.options?.hooks).toBeUndefined()
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://c:4318'
			for (const definition of [
				defineService({ name: 'S', handlers }),
				defineWorkflow({ name: 'W', handlers }),
				defineObject({ name: 'O', handlers }),
			]) {
				expect(definition.options.hooks[0]).toBe(TRACING_HOOK)
			}
			expect(defineService({ name: 'S', handlers }).service.run).toBeFunction()
		} finally {
			if (saved === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
			else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved
		}
	})
})

describe('startTelemetry', () => {
	test('without an endpoint nothing is registered, and the helpers do nothing', async () => {
		expect(startTelemetry({ env: {} }).enabled).toBe(false)
		expect(() => setSpanAttributes({ never: 'recorded' })).not.toThrow()
		expect(() => addSpanEvent('never')).not.toThrow()
		await flushTelemetry() // a no-op, and it does not wait
	})

	test('the first call decides; later calls return the same result', () => {
		const first = startTelemetry({ env: {} })
		expect(startTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' } })).toBe(
			first,
		)
	})
})

describe('spans', () => {
	test('a span per attempt under the trace Restate passes in, and a child span per ctx.run', async () => {
		const exporter = tracing()
		const hook = attempt()
		await hook.handler(async () => {
			await hook.run('fetch-data', async () => setSpanAttributes({ 'app.rows': 3 }))
		})
		const spans = exporter.getFinishedSpans()
		const run = spans.find((s) => s.name === 'run (fetch-data)')
		const top = spans.find((s) => s.name === 'attempt Greeter/greet')
		expect(top.spanContext().traceId).toBe(TRACE_ID)
		expect(top.parentSpanContext?.spanId ?? top.parentSpanId).toBe(PARENT_SPAN)
		expect(top.attributes).toMatchObject({
			'restate.invocation.id': 'inv_1',
			'restate.invocation.target': 'Greeter/greet',
		})
		expect(run.spanContext().traceId).toBe(TRACE_ID)
		expect(run.attributes).toMatchObject({ 'restate.run.name': 'fetch-data', 'app.rows': 3 })
	})

	test('an error passes through unchanged, and marks the span', async () => {
		const exporter = tracing()
		const error = new TerminalError('no', { errorCode: 400 })
		const caught = await attempt()
			.handler(async () => {
				throw error
			})
			.catch((e) => e)
		expect(caught).toBe(error)
		expect(exporter.getFinishedSpans()[0].status.code).toBe(2) // ERROR
	})

	test('a validation failure is an event on the handler span, with the side and never the payload', async () => {
		const exporter = tracing()
		const handler = withValidation(
			{ type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
			{ type: 'object' },
			async () => ({}),
		)
		await attempt()
			.handler(() => handler({}, { secret: 'x' }))
			.catch(() => {})
		const [event] = exporter.getFinishedSpans()[0].events
		expect(event.name).toBe('validation.failed')
		expect(event.attributes['validation.side']).toBe('input')
		expect(JSON.stringify(event.attributes)).not.toContain('secret')
	})

	test('helpers outside a span do nothing and never throw', () => {
		tracing()
		expect(() => setSpanAttributes({ a: 1 })).not.toThrow()
		expect(() => addSpanEvent('e')).not.toThrow()
	})
	test('an agent step carries the GenAI attributes on its span, and no prompt or reply text', async () => {
		const exporter = tracing()
		const model = new MockLanguageModelV4({ doGenerate: textResult('the secret reply') })
		await attempt('Agent/ask').handler(() =>
			runAgentLoop(fakeCtx(), { model, system: '', prompt: 'the secret prompt' }),
		)
		const [span] = exporter.getFinishedSpans()
		expect(span.attributes['gen_ai.operation.name']).toBe('chat')
		expect(span.attributes['empyria.agent.step']).toBe(0)
		expect(JSON.stringify(span.attributes)).not.toContain('secret')
	})
})

describe('genAiAttributes', () => {
	test('a model step as GenAI attributes, without the undefined ones', () => {
		expect(
			genAiAttributes(
				{ model: 'm', finishReason: 'stop', inputTokens: 10, outputTokens: 4 },
				2,
			),
		).toEqual({
			'gen_ai.operation.name': 'chat',
			'gen_ai.request.model': 'm',
			'gen_ai.response.finish_reasons': ['stop'],
			'gen_ai.usage.input_tokens': 10,
			'gen_ai.usage.output_tokens': 4,
			'empyria.agent.step': 2,
		})
		expect(genAiAttributes({}, 0)).toEqual({
			'gen_ai.operation.name': 'chat',
			'empyria.agent.step': 0,
		})
	})
})
