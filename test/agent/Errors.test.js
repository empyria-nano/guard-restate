import { describe, test, expect } from 'bun:test'
import { TerminalError, RetryableError } from '@restatedev/restate-sdk'
import { APICallError } from '@ai-sdk/provider'
import { toRestateLLMError, DEFAULT_LLM_RETRY } from '../../lib/agent/Errors.js'

function apiError({ statusCode, isRetryable, responseHeaders } = {}) {
	return new APICallError({
		message: `request failed with status ${statusCode}`,
		url: 'https://llm.example/v1/chat/completions',
		requestBodyValues: {},
		statusCode,
		isRetryable,
		responseHeaders,
	})
}

describe('toRestateLLMError', () => {
	test('non-APICallError errors pass through unchanged (Restate treats them as retryable by default)', () => {
		const original = new TypeError('fetch failed')
		expect(toRestateLLMError(original)).toBe(original)
	})

	test('a non-retryable APICallError (e.g. 401) becomes a TerminalError carrying the status code', () => {
		const error = apiError({ statusCode: 401, isRetryable: false })
		const mapped = toRestateLLMError(error)

		expect(mapped).toBeInstanceOf(TerminalError)
		expect(mapped.message).toBe(error.message)
		expect(mapped.code).toBe(401)
	})

	test('a retryable APICallError with no Retry-After header passes through unchanged', () => {
		const error = apiError({ statusCode: 500, isRetryable: true })
		expect(toRestateLLMError(error)).toBe(error)
	})

	test('a retryable APICallError with a Retry-After header becomes a RetryableError honoring it', () => {
		const error = apiError({
			statusCode: 429,
			isRetryable: true,
			responseHeaders: { 'retry-after': '20' },
		})
		const mapped = toRestateLLMError(error)

		expect(mapped).toBeInstanceOf(RetryableError)
		expect(mapped.retryAfter).toEqual({ seconds: 20 })
	})

	test('a retryable APICallError with a non-numeric Retry-After header passes through unchanged', () => {
		// e.g. an HTTP-date form of Retry-After, which this module doesn't attempt to parse —
		// falling back to ctx.run's own RunOptions backoff is safer than mis-parsing it.
		const error = apiError({
			statusCode: 429,
			isRetryable: true,
			responseHeaders: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
		})
		expect(toRestateLLMError(error)).toBe(error)
	})
})

describe('DEFAULT_LLM_RETRY', () => {
	test('bounds attempts instead of retrying forever', () => {
		expect(DEFAULT_LLM_RETRY.maxRetryAttempts).toBeGreaterThan(0)
		expect(Number.isFinite(DEFAULT_LLM_RETRY.maxRetryAttempts)).toBe(true)
	})
})
