import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { defaultResource, detectResources, envDetector } from '@opentelemetry/resources'
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { openTelemetryHook } from '@restatedev/restate-sdk-opentelemetry'

/**
 * Transparent OpenTelemetry tracing for every service built with this package.
 *
 * Nothing changes for a service author. `defineService`/`defineWorkflow`/`defineObject` add {@link TRACING_HOOK} (Restate's
 * own `openTelemetryHook`): a span per handler attempt, a child span per `ctx.run` that executes, both under the trace
 * Restate passes in its attempt headers. `serveEndpoint`/`setupRestate` call {@link startTelemetry}, which exports those
 * spans over OTLP/HTTP when the standard OpenTelemetry environment asks for it, and does nothing otherwise:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT          e.g. http://collector:4318 (traces go to <endpoint>/v1/traces)
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   the full traces URL instead; wins over the one above
 *   OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES   who is reporting (whoever deploys the service sets them)
 *   OTEL_SDK_DISABLED=true               off, whatever else is set
 *
 * Optional, and off unless asked for. Without an endpoint (or with OTEL_SDK_DISABLED=true) the definitions get no hook,
 * no provider or context manager is registered, and nothing is traced: a service behaves exactly as before. A service
 * can also stay out while the rest is traced: `defineService({ name, handlers, tracing: false })`. When on, the hook
 * only observes: it rethrows every error unchanged.
 */

/** The instrumentation scope of the spans this package creates. */
export const TRACER_NAME = '@empyria/restate'

/**
 * The tracing hook every definition gets. One instance, so {@link withTracing} can tell it is already there. The tracer
 * is looked up per attempt, so a provider registered after the services were defined (at import time) is used.
 */
export const TRACING_HOOK = openTelemetryHook({ tracer: () => trace.getTracer(TRACER_NAME) })

/**
 * The definition with {@link TRACING_HOOK} first among its service-level hooks, keeping the hooks it has, when tracing is
 * on (the environment has an endpoint, see {@link tracesEndpoint}) and the definition does not say `tracing: false`.
 * Otherwise the definition as it was, without its `tracing` flag. A new object: the definition passed in is not changed.
 * Adding the hook twice has no effect.
 * @template {{options?: {hooks?: Array<unknown>}, tracing?: boolean}} D
 * @param {D} def
 * @param {Record<string, string | undefined>} [env] read when the definition is made, as a service defines its handlers
 * @returns {D}
 */
export function withTracing(def, env = process.env) {
	const { tracing, ...rest } = def
	const plain = tracing === undefined ? def : rest
	if (tracing === false || !tracesEndpoint(env)) return plain
	const hooks = plain.options?.hooks ?? []
	if (hooks.includes(TRACING_HOOK)) return plain
	return { ...plain, options: { ...plain.options, hooks: [TRACING_HOOK, ...hooks] } }
}

/**
 * The OTLP traces URL the environment asks for, or undefined when tracing is off.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function tracesEndpoint(env = process.env) {
	if (String(env.OTEL_SDK_DISABLED ?? '').toLowerCase() === 'true') return undefined
	if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
	if (env.OTEL_EXPORTER_OTLP_ENDPOINT)
		return `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, '')}/v1/traces`
	return undefined
}

let started

/**
 * Starts exporting traces when the environment asks for it (see the module comment). Idempotent: the first call decides,
 * later calls return the same result. `processor` replaces the OTLP exporter (tests pass an in-memory one).
 * @param {{env?: Record<string, string | undefined>, processor?: import('@opentelemetry/sdk-trace').SpanProcessor}} [options]
 * @returns {{enabled: boolean, endpoint?: string, flush: () => Promise<void>, shutdown: () => Promise<void>}}
 */
export function startTelemetry({ env = process.env, processor } = {}) {
	if (started) return started
	const endpoint = processor ? 'in-process' : tracesEndpoint(env)
	if (!endpoint) {
		started = { enabled: false, flush: async () => {}, shutdown: async () => {} }
		return started
	}
	// OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES (read from process.env by OpenTelemetry), over the SDK's defaults.
	const resource = defaultResource().merge(detectResources({ detectors: [envDetector] }))
	const provider = new TracerProvider({
		resource,
		spanProcessors: [
			processor ??
				new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: endpoint }) }),
		],
	})
	// The hook makes its spans active with `context.with`; without a context manager nothing would be active inside a
	// handler, and `trace.getActiveSpan()` (used for the agent's and validation's attributes) would find nothing.
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
	trace.setGlobalTracerProvider(provider)
	started = {
		enabled: true,
		endpoint,
		flush: () => provider.forceFlush(),
		shutdown: () => provider.shutdown(),
	}
	return started
}

/**
 * Sends the spans still buffered, waiting at most `timeoutMs`; for a process about to exit. Never throws.
 * @param {number} [timeoutMs]
 */
export async function flushTelemetry(timeoutMs = 1000) {
	if (!started?.enabled) return
	await Promise.race([
		started.flush().catch(() => {}),
		new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
	])
}

/**
 * Forgets what {@link startTelemetry} did and unregisters the global provider and context manager. For tests only.
 */
export async function resetTelemetry() {
	await started?.shutdown()
	started = undefined
	trace.disable()
	context.disable()
}

/**
 * Adds attributes to the span that is active (the handler attempt, or the `ctx.run` that executes). Nothing happens when
 * no span is recording, so callers need not check whether tracing is on. Never throws: telemetry must not change the
 * outcome of an invocation.
 * @param {import('@opentelemetry/api').Attributes} attributes
 */
export function setSpanAttributes(attributes) {
	try {
		const span = trace.getActiveSpan()
		if (span?.isRecording()) span.setAttributes(attributes)
	} catch {
		// telemetry only
	}
}

/**
 * Adds an event to the active span; see {@link setSpanAttributes}.
 * @param {string} name
 * @param {import('@opentelemetry/api').Attributes} [attributes]
 */
export function addSpanEvent(name, attributes) {
	try {
		const span = trace.getActiveSpan()
		if (span?.isRecording()) span.addEvent(name, attributes)
	} catch {
		// telemetry only
	}
}
