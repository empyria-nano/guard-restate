import { TerminalError } from '@restatedev/restate-sdk'
import { defineObject, defineService } from '../Admin.js'
import { withValidation } from '../Validation.js'
import { DEFAULT_AGENT_RETRY_POLICY } from './Errors.js'
import { runAgentLoop } from './Loop.js'
import { createModel } from './Model.js'
import { assertToolSpecs, jsonBytes } from './Tools.js'

/** Largest request an agent accepts, in JSON bytes: the input is journaled and sent to the model. */
export const DEFAULT_MAX_INPUT_BYTES = 64 * 1024

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
 * @property {Record<string, import('./Tools.js').ToolSpec> | ((input: any) => Record<string, import('./Tools.js').ToolSpec> | Promise<Record<string, import('./Tools.js').ToolSpec>>)} [tools]
 *   A fixed map, or a function of the validated request for tools that depend on it (for example
 *   confined to a folder the request names). The function runs outside any `ctx.run`, on every
 *   execution and replay: it must be pure and deterministic, and it must not do I/O. The returned
 *   map is checked like a fixed one; an invalid map fails the request terminally (500).
 * @property {object} [input] Input JSON Schema. Defaults to {@link AskInputSchema}.
 * @property {(input: any) => string} [prompt] Builds the user prompt from the validated
 *   input. Defaults to `input.prompt`.
 * @property {object | ((input: any) => object | undefined)} [output] Output JSON Schema. When given, the model
 *   must answer through the `final_answer` tool; its arguments are checked against the schema (a wrong answer is
 *   handed back to the model to correct) and `ask` returns them. A function chooses the schema per request, like
 *   `tools`: it runs on every execution and replay, so it must be pure and do no I/O; `undefined` means a free-text
 *   answer for that request. Defaults to {@link AskOutputSchema} (`{text, steps}`).
 * @property {(result: {text: string, output?: unknown, steps: number, totalTokens: number, trace: Array<object>}, input: any) => any} [respond]
 *   Shapes what `ask` returns from the loop's result (`output` is set when an `output` schema is
 *   given; `trace` is the per-step summary). Without it, `ask` returns `output`, or `{text, steps}`.
 * @property {object} [responseSchema] JSON Schema of what `respond` returns, checked before Restate
 *   records it (a mismatch is terminal, 500). Only used together with `respond`.
 * @property {(input: any) => string} [label] A short name for this request, for example the item it
 *   works on. A terminal failure inside the agent then reads `[label] message`, so a failed run says
 *   what it was working on. The error's code and metadata are kept; cancellations and timeouts are
 *   left alone.
 * @property {'none'|'session'} [memory] `none` (default): a stateless service. `session`: a
 *   virtual object keyed by session ID, so turns of one session run one at a time and see
 *   the conversation so far.
 * @property {HistoryStore} [historyStore] Session memory only. Without it, the conversation
 *   is kept in object state, trimmed to `limits.maxHistoryTurns` — fine for short
 *   sessions; long ones should use a store.
 * @property {{maxSteps?: number, maxTokens?: number, maxHistoryTurns?: number, maxInputBytes?: number}} [limits]
 *   `maxInputBytes` caps the request (JSON bytes, default {@link DEFAULT_MAX_INPUT_BYTES}); a larger
 *   one is refused terminally (413).
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
		respond,
		responseSchema,
		label,
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
	if (typeof tools !== 'function') assertToolSpecs(tools)
	if (respond !== undefined && typeof respond !== 'function') {
		throw new TypeError(`Agent '${name}': respond must be a function`)
	}
	if (label !== undefined && typeof label !== 'function') {
		throw new TypeError(`Agent '${name}': label must be a function`)
	}

	const {
		maxSteps,
		maxTokens,
		maxHistoryTurns = 20,
		maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
	} = limits

	// A per-request `output` cannot be known here; the loop checks the answer against the schema it was given.
	const outputSchema = respond
		? (responseSchema ?? {})
		: typeof output === 'function'
			? {}
			: (output ?? AskOutputSchema)

	const ask = withValidation(input, outputSchema, async (ctx, validatedInput) => {
		const inputBytes = jsonBytes(validatedInput)
		if (inputBytes > maxInputBytes) {
			throw withLabel(
				new TerminalError(
					`Agent '${name}': the request is ${inputBytes} bytes, over the limit of ${maxInputBytes}`,
					{ errorCode: 413 },
				),
				label,
				validatedInput,
			)
		}
		try {
			return await runAsk(ctx, validatedInput)
		} catch (error) {
			throw withLabel(error, label, validatedInput)
		}
	})

	async function runAsk(ctx, validatedInput) {
		const userPrompt = prompt(validatedInput)
		if (typeof userPrompt !== 'string' || userPrompt === '') {
			throw new TerminalError(`Agent '${name}': the input produced no prompt`, {
				errorCode: 400,
			})
		}
		const requestTools =
			typeof tools === 'function' ? await resolveTools(name, tools, validatedInput) : tools

		const requestOutput = typeof output === 'function' ? output(validatedInput) : output

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
			tools: requestTools,
			skills: context.skills,
			loadSkill: skillLoader({ loadSkill, loadContext, input: validatedInput }),
			loadHistory: session?.load,
			outputSchema: requestOutput,
			maxSteps,
			maxTokens,
			retry: llmRetry,
		})

		if (session) await session.save(result.messages, maxHistoryTurns)

		if (respond) return respond(result, validatedInput)
		return requestOutput ? result.output : { text: result.text, steps: result.steps }
	}

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

/** Resolves a request-dependent `tools` function, failing the request (not retrying) on a bad map. */
async function resolveTools(name, tools, input) {
	try {
		const resolved = await tools(input)
		assertToolSpecs(resolved ?? {})
		return resolved ?? {}
	} catch (error) {
		throw new TerminalError(
			`Agent '${name}': invalid tools for this request: ${error.message}`,
			{
				errorCode: 500,
			},
		)
	}
}

/**
 * Prefixes a plain `TerminalError` with the request's label. Anything else (a retryable error, a
 * cancellation, a timeout) is returned untouched, so Restate's own handling of it is unchanged.
 */
function withLabel(error, label, input) {
	if (!label || error?.constructor !== TerminalError) return error
	return new TerminalError(`[${label(input)}] ${error.message}`, {
		errorCode: error.code,
		metadata: error.metadata,
	})
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
