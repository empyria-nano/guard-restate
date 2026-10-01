import { TerminalError, RetryableError } from '@restatedev/restate-sdk'
import { APICallError } from '@ai-sdk/provider'

/**
 * Default bounded retry policy for an LLM call's durable `ctx.run` step.
 *
 * `ctx.run`'s own SDK-wide defaults (`initialRetryInterval: 50ms`, unbounded attempts)
 * are tuned for cheap, fast-failing side effects, not a rate-limited LLM gateway — a
 * 50ms-then-double backoff burns through a 429's typical multi-second cooldown in a
 * handful of attempts, and with no `maxRetryAttempts` it never gives up on a
 * genuinely-broken endpoint. `maxRetryAttempts` also matters independently of the
 * interval tuning: without it, any error this module fails to classify as
 * {@link TerminalError} (see {@link toRestateLLMError}) retries forever.
 */
export const DEFAULT_LLM_RETRY = {
	maxRetryAttempts: 5,
	initialRetryInterval: 1_000,
	maxRetryInterval: 30_000,
	retryIntervalFactor: 2,
}

/**
 * Default bounded retry policy for an `execute` tool's durable `ctx.run` step. Once it's
 * exhausted, `ctx.run` throws a `TerminalError`, which the agent loop hands back to the
 * model as a tool error instead of failing the whole invocation — see `Tools.js`.
 */
export const DEFAULT_TOOL_RETRY = {
	maxRetryAttempts: 3,
	initialRetryInterval: 500,
	maxRetryInterval: 10_000,
	retryIntervalFactor: 2,
}

/**
 * Default invocation-level retry policy for an agent service/object. Applies to failures
 * outside any bounded `ctx.run` (e.g. a bug in the handler itself): after `maxAttempts`
 * the invocation is paused for an operator to fix and resume, never retried forever and
 * never silently killed.
 */
export const DEFAULT_AGENT_RETRY_POLICY = {
	maxAttempts: 10,
	onMaxAttempts: 'pause',
}

/**
 * Maps an error thrown by an AI SDK Core call (`generateText`/`streamText`/...) to the
 * error a `ctx.run(name, fn, RunOptions)` closure should throw, so Restate retries
 * exactly the failures worth retrying and stops immediately on the ones that aren't.
 *
 * `@ai-sdk/provider`'s `APICallError` already carries an `isRetryable` flag the AI SDK
 * itself derives from the HTTP status code (true for 408/409/429/5xx, false for
 * 400/401/403/404/422/...) — this reuses that classification instead of re-deriving it
 * from status codes by hand, and layers Restate's two escape hatches on top of it:
 *
 * - Not retryable → {@link TerminalError}, so Restate fails the invocation immediately
 *   instead of retrying an auth/config/bad-request error forever.
 * - Retryable AND the response carried a `Retry-After` header → {@link RetryableError},
 *   so Restate honors the gateway's own requested cooldown instead of guessing one.
 * - Retryable with no such header → the original error, unchanged, so `ctx.run`'s own
 *   `RunOptions` backoff (see {@link DEFAULT_LLM_RETRY}) applies.
 * - Anything that isn't an `APICallError` at all (a thrown `TypeError`, a network-layer
 *   error `fetch` itself throws, ...) is returned unchanged — Restate's default is to
 *   treat any non-`TerminalError` throw as retryable, which is the right default for an
 *   error shape this module doesn't recognize.
 *
 * Call sites re-throw the result — this function never throws itself, only classifies:
 * `catch (error) { throw toRestateLLMError(error) }`.
 * @param {unknown} error
 * @returns {Error}
 */
export function toRestateLLMError(error) {
	if (!APICallError.isInstance(error)) return error

	if (!error.isRetryable) {
		return new TerminalError(error.message, { errorCode: error.statusCode })
	}

	const retryAfterHeader = error.responseHeaders?.['retry-after']
	const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined

	if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
		return RetryableError.from(error, { retryAfter: { seconds: retryAfterSeconds } })
	}

	return error
}
