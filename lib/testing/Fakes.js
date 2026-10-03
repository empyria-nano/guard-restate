import { TerminalError } from '@restatedev/restate-sdk'

/**
 * Test doubles for agent code, shipped as `@empyria/restate/testing`. No dependency on the AI SDK.
 *
 * A stand-in for Restate's `Context` / `ObjectContext`. Per this repo's testing convention,
 * handlers are unit-tested against a mocked `ctx`, never a live Restate server.
 *
 * `run` mimics the parts of the real one the agent depends on: the result goes through a
 * JSON round trip (as it does through the journal), and when a bounded `ctx.run` gives up
 * it throws a `TerminalError` wrapping the original message. One attempt stands in for
 * "all retries exhausted".
 */
export function fakeCtx({ key, state = {}, onCall, onApproval } = {}) {
	const steps = []
	const calls = []
	const sends = []
	const logs = []
	return {
		key,
		logs,
		console: { log: (...args) => logs.push(args.join(' ')) },
		state,
		steps,
		calls,
		sends,
		run: async (name, fn, options) => {
			const step = { name, options }
			steps.push(step)
			let value
			try {
				value = await fn()
			} catch (error) {
				if (error instanceof TerminalError || !options?.maxRetryAttempts) throw error
				throw new TerminalError(error.message)
			}
			step.result = value === undefined ? undefined : JSON.parse(JSON.stringify(value))
			return step.result
		},
		request: () => ({ id: 'inv-1' }),
		genericCall: async (call) => {
			calls.push(call)
			return onCall ? onCall(call) : null
		},
		genericSend: (send) => {
			sends.push(send)
		},
		awakeable: () => ({
			id: 'awk-1',
			promise: { orTimeout: async (timeout) => onApproval?.(timeout) },
		}),
		get: async (name) => state[name],
		set: (name, value) => {
			state[name] = value
		},
		clear: (name) => {
			delete state[name]
		},
	}
}

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }

export function textResult(text) {
	return {
		content: [{ type: 'text', text }],
		finishReason: { unified: 'stop', raw: 'stop' },
		usage,
		warnings: [],
	}
}

/** @param {Array<{toolName: string, input: object}>} calls */
export function toolCallResult(calls) {
	return {
		content: calls.map(({ toolName, input }, i) => ({
			type: 'tool-call',
			toolCallId: `call_${i}`,
			toolName,
			input: JSON.stringify(input),
		})),
		finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
		usage,
		warnings: [],
	}
}

/** `doGenerate` that returns `results` one after another. */
export function sequence(...results) {
	let i = 0
	return async () => results[Math.min(i++, results.length - 1)]
}
