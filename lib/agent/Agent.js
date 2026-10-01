import { TerminalError } from '@restatedev/restate-sdk'
import { defineObject, defineService } from '../Admin.js'
import { withValidation } from '../Validation.js'
import { DEFAULT_AGENT_RETRY_POLICY } from './Errors.js'
import { runAgentLoop } from './Loop.js'
import { createModel } from './Model.js'
import { assertToolSpecs } from './Tools.js'

const HISTORY = 'history'
const HISTORY_REF = 'historyRef'

export const AskInputSchema = {
	type: 'object',
	properties: {
		prompt: { type: 'string', minLength: 1 },
		skillsFolder: { type: 'string' },
		department: { type: 'string' },
		threadId: { type: 'string' },
		resourceId: { type: 'string' },
	},
	required: ['prompt'],
	additionalProperties: false,
}

export const AskOutputSchema = {
	type: 'object',
	properties: {
		text: { type: 'string' },
		steps: { type: 'number' },
	},
	required: ['text', 'steps'],
	additionalProperties: false,
}

/**
 * @typedef {Object} HistoryStore External storage for a session agent's conversation, so
 *   the journal and object state only ever hold a reference to it.
 * @property {(ref: string) => Promise<Array<object>>} load Returns the messages saved under
 *   `ref`. Must return the same messages for the same `ref` every time: refs are immutable
 *   snapshots, e.g. a content hash or a versioned object key.
 * @property {(sessionKey: string, messages: Array<object>) => Promise<string>} save Stores
 *   the full conversation as a new snapshot and returns its ref.
 *
 * @typedef {Object} AgentSpec
 * @property {string} name Restate service / object name. Required: each agent is its own
 *   building block.
 * @property {{LLM_BASE_URL: string, LLM_API_KEY?: string, MODEL_ID: string}} [env] Builds the
 *   model via {@link createModel}, unless `model` is given.
 * @property {import('@ai-sdk/provider').LanguageModelV4} [model]
 * @property {string} [system] Static system prompt, prepended to `loadContext`'s.
 * @property {(input: any) => Promise<{systemPrompt?: string, skills?: Array<{name: string, description: string, body?: string}>}>} [loadContext]
 *   Resolves this request's system prompt and skills. Runs in its own `ctx.run`, which
 *   records only the system prompt and the skill index — never the skill bodies.
 * @property {(name: string, input: any) => Promise<string|undefined>} [loadSkill] Fetches one
 *   skill body when the model asks for it. Defaults to re-running `loadContext` and
 *   picking the body by name. The journal records only the skill's name and hash; the
 *   body is fetched again before every model call. So it must return the same content
 *   for the whole invocation (skills shipped with the deployment do), or the invocation
 *   fails terminally rather than send the model changed instructions.
 * @property {Record<string, import('./Tools.js').ToolSpec>} [tools]
 * @property {object} [input] Input JSON Schema. Defaults to {@link AskInputSchema}.
 * @property {(input: any) => string} [prompt] Builds the user prompt from the validated
 *   input. Defaults to `input.prompt`.
 * @property {object} [output] Output JSON Schema. When given, the model must answer through
 *   the `final_answer` tool and `ask` returns its arguments. Defaults to
 *   {@link AskOutputSchema} (`{text, steps}`).
 * @property {'none'|'session'} [memory] `none` (default): a stateless service. `session`: a
 *   virtual object keyed by session ID, so turns of one session run one at a time and see
 *   the conversation so far.
 * @property {HistoryStore} [historyStore] Session memory only. Without it, the conversation
 *   is kept in object state, trimmed to `limits.maxHistoryTurns` — fine for short
 *   sessions; long ones should use a store.
 * @property {{maxSteps?: number, maxTokens?: number, maxHistoryTurns?: number}} [limits]
 * @property {import('@restatedev/restate-sdk').RunOptions<any>} [llmRetry] Retry policy of
 *   each LLM call step. Defaults to `DEFAULT_LLM_RETRY`.
 * @property {import('@restatedev/restate-sdk').RetryPolicy} [retryPolicy] Invocation-level
 *   retry policy. Defaults to {@link DEFAULT_AGENT_RETRY_POLICY}.
 */

/**
 * Defines an LLM agent as a Restate building block. Restate itself has no agent
 * primitive: this generates a regular service (`memory: 'none'`) or virtual object
 * (`memory: 'session'`) with an `ask` handler that runs {@link runAgentLoop}, and enforces
 * what a hand-written agent service tends to get wrong:
 *
 * - every LLM call and tool call is its own bounded, durable step;
 * - tools are Restate calls to other building blocks, or bounded `ctx.run` side effects
 *   that get an idempotency key;
 * - tools can require approval through an awakeable, with a timeout;
 * - input and output are validated, and failures are terminal;
 * - step and token budgets, and an explicit invocation retry policy;
 * - the journal holds only small values: the skill index, never skill bodies; a session
 *   store's reference, never the conversation.
 *
 * Session agents also get a `reset` handler that forgets the conversation.
 * @param {AgentSpec} spec
 * @returns {import('@restatedev/restate-sdk').ServiceDefinition<string, unknown> | import('@restatedev/restate-sdk').VirtualObjectDefinition<string, unknown>}
 * @throws {TypeError} If the spec is invalid.
 */
export function defineAgent(spec) {
	const {
		name,
		env,
		model = env ? createModel(env) : undefined,
		system = '',
		loadContext,
		loadSkill,
		tools = {},
		input = AskInputSchema,
		prompt = (validatedInput) => validatedInput.prompt,
		output,
		memory = 'none',
		historyStore,
		limits = {},
		llmRetry,
		retryPolicy = DEFAULT_AGENT_RETRY_POLICY,
	} = spec

	if (typeof name !== 'string' || name === '') {
		throw new TypeError('defineAgent needs a name')
	}
	if (!model) throw new TypeError(`Agent '${name}' needs a model or an env to build one from`)
	if (memory !== 'none' && memory !== 'session') {
		throw new TypeError(`Agent '${name}': memory must be 'none' or 'session'`)
	}
	if (historyStore && memory !== 'session') {
		throw new TypeError(`Agent '${name}': historyStore needs memory: 'session'`)
	}
	assertToolSpecs(tools)

	const { maxSteps, maxTokens, maxHistoryTurns = 20 } = limits

	const ask = withValidation(input, output ?? AskOutputSchema, async (ctx, validatedInput) => {
		const userPrompt = prompt(validatedInput)
		if (typeof userPrompt !== 'string' || userPrompt === '') {
			throw new TerminalError(`Agent '${name}': the input produced no prompt`, {
				errorCode: 400,
			})
		}

		const context = loadContext
			? await ctx.run('load-context', async () => {
					const { systemPrompt = '', skills = [] } =
						(await loadContext(validatedInput)) ?? {}
					return {
						systemPrompt,
						skills: skills.map((skill) => ({
							name: skill.name,
							description: skill.description,
						})),
					}
				})
			: { systemPrompt: '', skills: [] }

		const session = memory === 'session' ? await openSession(ctx, historyStore) : undefined

		const result = await runAgentLoop(ctx, {
			model,
			system: [system, context.systemPrompt].filter(Boolean).join('\n\n'),
			prompt: userPrompt,
			tools,
			skills: context.skills,
			loadSkill: skillLoader({ loadSkill, loadContext, input: validatedInput }),
			loadHistory: session?.load,
			outputSchema: output,
			maxSteps,
			maxTokens,
			retry: llmRetry,
		})

		if (session) await session.save(result.messages, maxHistoryTurns)

		return output ? result.output : { text: result.text, steps: result.steps }
	})

	const options = { retryPolicy }

	if (memory === 'none') {
		return defineService({ name, handlers: { ask }, options })
	}

	return defineObject({
		name,
		handlers: {
			ask,
			reset: async (ctx) => {
				ctx.clear(HISTORY)
				ctx.clear(HISTORY_REF)
			},
		},
		options,
	})
}

/**
 * The session's conversation: `load` returns the previous turns' messages (memoised for
 * this execution; called inside each LLM step, so never journaled), `save` appends this
 * turn's messages.
 * @param {import('@restatedev/restate-sdk').ObjectContext} ctx
 * @param {HistoryStore} [store]
 */
async function openSession(ctx, store) {
	if (store) {
		const ref = await ctx.get(HISTORY_REF)
		let cached
		const load = async () => (cached ??= ref ? await store.load(ref) : [])
		return {
			load,
			save: async (messages) => {
				const newRef = await ctx.run('save-history', async () =>
					store.save(ctx.key, [...(await load()), ...messages]),
				)
				ctx.set(HISTORY_REF, newRef)
			},
		}
	}

	// Without a store, history lives in object state as a list of turns, so trimming never
	// separates a tool call from its result.
	const turns = (await ctx.get(HISTORY)) ?? []
	return {
		load: async () => turns.flat(),
		save: async (messages, maxHistoryTurns) => {
			ctx.set(HISTORY, [...turns, messages].slice(-maxHistoryTurns))
		},
	}
}

function skillLoader({ loadSkill, loadContext, input }) {
	if (loadSkill) return (skillName) => loadSkill(skillName, input)
	if (!loadContext) return undefined
	return async (skillName) => {
		const { skills = [] } = (await loadContext(input)) ?? {}
		return skills.find((skill) => skill.name === skillName)?.body
	}
}

/**
 * @deprecated Use {@link defineAgent} with an explicit `name`. Kept so callers migrating
 *   from `@empyria/restate-llm` only change their import: defines a stateless agent named
 *   `AgentService` with the default `ask` input/output.
 * @param {Omit<AgentSpec, 'name'>} spec
 */
export function createAgentService(spec) {
	return defineAgent({ name: 'AgentService', ...spec })
}
