import { describe, test, expect } from 'bun:test'
import { TerminalError } from '@restatedev/restate-sdk'
import { createModel, readLlmEnv } from '../../lib/agent/Model.js'

const ok = { LLM_BASE_URL: 'https://llm.example/v1', MODEL_ID: 'm', LLM_API_KEY: 'sk-secret-value' }

describe('readLlmEnv', () => {
	test('returns just the three LLM settings', () => {
		expect(readLlmEnv({ ...ok, PATH: '/bin', OTHER: 'x' })).toEqual(ok)
	})

	test('the key is optional', () => {
		const { LLM_API_KEY: _, ...noKey } = ok
		expect(readLlmEnv(noKey)).toEqual(noKey)
	})

	test('empty strings count as missing', () => {
		expect(() => readLlmEnv({ ...ok, MODEL_ID: '' })).toThrow(TerminalError)
	})

	test('a missing setting is a terminal 500 that names it and never prints a value', () => {
		const error = (() => {
			try {
				readLlmEnv({
					LLM_BASE_URL: 'https://llm.example/v1',
					LLM_API_KEY: 'sk-secret-value',
				})
			} catch (e) {
				return e
			}
		})()
		expect(error).toBeInstanceOf(TerminalError)
		expect(error.code).toBe(500)
		expect(error.message).toContain('MODEL_ID')
		expect(error.message).not.toContain('sk-secret-value')
		expect(error.message).not.toContain('llm.example')
	})

	test('the result feeds createModel', () => {
		expect(createModel(readLlmEnv(ok)).modelId).toBe('m')
	})
})
