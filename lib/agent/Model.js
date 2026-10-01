import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

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
