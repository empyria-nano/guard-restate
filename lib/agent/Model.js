import { TerminalError } from '@restatedev/restate-sdk'
import { createValidator } from '@empyria/common'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

/** JSON Schema of the environment variables that describe an LLM connection. */
export const LlmEnvSchema = {
	type: 'object',
	required: ['LLM_BASE_URL', 'MODEL_ID'],
	properties: {
		LLM_BASE_URL: { type: 'string', minLength: 1 },
		LLM_API_KEY: { type: 'string' },
		MODEL_ID: { type: 'string', minLength: 1 },
	},
}

const validateLlmEnv = createValidator(LlmEnvSchema)

/**
 * Reads the LLM connection from the environment (or any object) and checks it. A missing setting is
 * a deployment mistake that no retry can fix, so it fails as a `TerminalError` (code 500) that names
 * the problem and never prints a value, in particular not the API key.
 * @param {Record<string, string|undefined>} [source] Defaults to `process.env`.
 * @returns {{LLM_BASE_URL: string, LLM_API_KEY?: string, MODEL_ID: string}} Only the three LLM
 *   settings, ready for {@link createModel}.
 * @throws {TerminalError}
 */
export function readLlmEnv(source = process.env) {
	const picked = {}
	for (const key of ['LLM_BASE_URL', 'LLM_API_KEY', 'MODEL_ID']) {
		if (typeof source[key] === 'string' && source[key] !== '') picked[key] = source[key]
	}
	try {
		return validateLlmEnv(picked)
	} catch {
		const missing = LlmEnvSchema.required.filter((key) => !(key in picked))
		throw new TerminalError(
			`LLM is not configured: set ${missing.join(' and ') || 'LLM_BASE_URL and MODEL_ID'} (and usually LLM_API_KEY)`,
			{ errorCode: 500 },
		)
	}
}

/**
 * AI SDK Core model, pointed at an OpenAI-compatible endpoint — Bifrost
 * (llm-system's gateway) by default, fully overridable via env. `LLM_BASE_URL`
 * already includes the `/v1` suffix Bifrost's own docs use (`https://agent-bureau.vip/v1`);
 * `MODEL_ID` defaults to `vllm/ornith-1.5`, the currently-live routed model ID on that
 * gateway (see llm-system's README, "Verifying").
 * @param {{LLM_BASE_URL: string, LLM_API_KEY?: string, MODEL_ID: string}} env
 * @returns {import('@ai-sdk/provider').LanguageModelV4}
 */
export function createModel(env) {
	const provider = createOpenAICompatible({
		name: 'bifrost',
		baseURL: env.LLM_BASE_URL,
		apiKey: env.LLM_API_KEY,
	})
	return provider(env.MODEL_ID)
}
