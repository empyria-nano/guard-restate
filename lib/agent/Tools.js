import { tool, jsonSchema } from 'ai'
import { CancelledError, TerminalError, TimeoutError, serde } from '@restatedev/restate-sdk'
import { defineSchema, string } from '@empyria/common'
import { DEFAULT_TOOL_RETRY } from './Errors.js'
import { LOAD_SKILL_TOOL, hashSkill, skillRefOutput } from './Skills.js'

/**
 * Tool names the agent loop owns itself; a user-declared tool can't reuse them.
 */
export { LOAD_SKILL_TOOL }
export const FINAL_ANSWER_TOOL = 'final_answer'

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Default size caps for a tool call, in bytes of its JSON form. Tool arguments are recorded in the
 * journal as part of the model's response and tool results are recorded when the tool finishes, and
 * Restate replays all of it on every retry: only small values belong there. Override per tool with
 * `maxInputBytes` / `maxOutputBytes`; a tool that must handle bigger data should keep it outside the
 * journal and pass a reference instead.
 */
export const DEFAULT_TOOL_MAX_INPUT_BYTES = 16 * 1024
export const DEFAULT_TOOL_MAX_OUTPUT_BYTES = 32 * 1024

/** Size of a value's JSON form, in bytes. */
export const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value) ?? '')

/**
 * @typedef {Object} ApprovalSpec Human (or system) approval required before a tool runs.
 * @property {number} timeout Milliseconds to wait for a decision. A timeout counts as a
 *   rejection.
 * @property {{block: string|{name: string}, handler: string, key?: string}} notify Handler
 *   that's sent `{awakeableId, tool, input, invocationId}` when approval is needed. The
 *   approver answers by resolving the awakeable with `{approved: boolean, reason?: string}`
 *   (Restate ingress: `POST /restate/awakeables/<awakeableId>/resolve`).
 *
 * @typedef {Object} BlockToolSpec A tool executed as a Restate call to another building block.
 *   Restate journals the call, retries it inside the callee and guarantees it runs once.
 * @property {string} description
 * @property {object} inputSchema JSON Schema of the tool's arguments, shown to the model.
 * @property {string|{name: string}} block Target service/object/workflow, by name or definition.
 * @property {string} handler Target handler.
 * @property {(args: any, meta: {idempotencyKey: string}) => string} [key] Virtual object / workflow key, derived from
 *   the model's arguments and a per-call idempotency key (`<invocation id>:<step>.<index>`, unique for every tool
 *   call). A key that is the same for several calls makes those calls run one at a time; a key built from
 *   `meta.idempotencyKey` makes every call its own key, so they run in parallel. Must not throw.
 * @property {(args: any, meta: {idempotencyKey: string}) => any} [input] Builds the parameter sent to the target
 *   handler from the model's arguments, for adding what the model must not control (who the caller is, which
 *   folder is allowed) or the idempotency key. Default: the arguments as they are. Must not throw.
 * @property {ApprovalSpec} [approval]
 * @property {number} [maxInputBytes] Largest accepted arguments (JSON bytes). Default
 *   {@link DEFAULT_TOOL_MAX_INPUT_BYTES}. A larger call is not made; the model is told why.
 * @property {number} [maxOutputBytes] Largest result handed to the model (JSON bytes). Default
 *   {@link DEFAULT_TOOL_MAX_OUTPUT_BYTES}. A larger result is replaced by an error the model sees.
 *
 * @typedef {Object} ExecuteToolSpec A tool executed as a direct side effect inside its own `ctx.run`.
 * @property {string} description
 * @property {object} inputSchema JSON Schema of the tool's arguments, shown to the model.
 * @property {(args: any, meta: {idempotencyKey: string}) => any} execute Runs the side effect.
 *   May run more than once before its result is recorded: pass `idempotencyKey` on to the
 *   external system for any write. Must return a small JSON-serialisable value.
 * @property {import('@restatedev/restate-sdk').RunOptions<any>} [retry] Defaults to
 *   {@link DEFAULT_TOOL_RETRY}.
 * @property {ApprovalSpec} [approval]
 * @property {number} [maxInputBytes] As on {@link BlockToolSpec}.
 * @property {number} [maxOutputBytes] As on {@link BlockToolSpec}. Checked inside the tool's own
 *   `ctx.run`, so an oversized result is never recorded in the journal.
 *
 * @typedef {BlockToolSpec|ExecuteToolSpec} ToolSpec
 */

/**
 * Validates a `tools` map at definition time, so a misconfigured agent fails on startup
 * rather than on its first invocation.
 * @param {Record<string, ToolSpec>} tools
 * @throws {TypeError}
 */
export function assertToolSpecs(tools) {
	for (const [name, spec] of Object.entries(tools)) {
		if (!TOOL_NAME.test(name)) {
			throw new TypeError(`Invalid tool name '${name}': use [a-zA-Z0-9_-], at most 64 chars`)
		}
		if (name === LOAD_SKILL_TOOL || name === FINAL_ANSWER_TOOL) {
			throw new TypeError(`Tool name '${name}' is reserved by the agent loop`)
		}
		if (typeof spec.description !== 'string' || !spec.inputSchema) {
			throw new TypeError(`Tool '${name}' needs a description and an inputSchema`)
		}
		const isBlock = spec.block !== undefined
		const isExecute = typeof spec.execute === 'function'
		if (isBlock === isExecute) {
			throw new TypeError(`Tool '${name}' needs exactly one of 'block' or 'execute'`)
		}
		if (isBlock && typeof spec.handler !== 'string') {
			throw new TypeError(`Block tool '${name}' needs a 'handler'`)
		}
		for (const hook of ['key', 'input']) {
			if (spec[hook] !== undefined && typeof spec[hook] !== 'function') {
				throw new TypeError(`Tool '${name}': ${hook} must be a function`)
			}
		}
		for (const cap of ['maxInputBytes', 'maxOutputBytes']) {
			if (spec[cap] !== undefined && !(Number.isInteger(spec[cap]) && spec[cap] > 0)) {
				throw new TypeError(`Tool '${name}': ${cap} must be a positive integer`)
			}
		}
		if (spec.approval) {
			const { timeout, notify } = spec.approval
			if (!(timeout > 0) || !notify?.block || !notify?.handler) {
				throw new TypeError(
					`Tool '${name}' approval needs a positive 'timeout' and a 'notify' {block, handler}`,
				)
			}
		}
	}
}

/**
 * AI SDK tool definitions for the model. None has an `execute`: AI SDK then returns the
 * requested call instead of running it, so {@link executeTool} owns every execution as
 * its own durable step.
 * @param {{tools: Record<string, ToolSpec>, hasSkills: boolean, outputSchema?: object}} params
 */
export function buildToolDefs({ tools, hasSkills, outputSchema }) {
	const defs = Object.fromEntries(
		Object.entries(tools).map(([name, spec]) => [
			name,
			tool({ description: spec.description, inputSchema: jsonSchema(spec.inputSchema) }),
		]),
	)
	if (hasSkills) {
		defs[LOAD_SKILL_TOOL] = tool({
			description:
				"Load the full instructions for a named skill, by the name shown in the system prompt's skill index.",
			inputSchema: jsonSchema(defineSchema({ name: string() })),
		})
	}
	if (outputSchema) {
		defs[FINAL_ANSWER_TOOL] = tool({
			description: 'Return your final answer. Call this exactly once, when you are done.',
			inputSchema: jsonSchema(outputSchema),
		})
	}
	return defs
}

/**
 * Executes one model-requested tool call and returns the AI SDK tool-result `output`.
 *
 * Error policy (see the workflow model, §7): a tool that fails terminally — rejected
 * approval, a `TerminalError` from the callee, an `execute` tool whose retries ran out —
 * is reported back to the model as `error-text`, so the agent can adapt. Transient errors
 * are never swallowed: Restate retries them. Cancellation always propagates.
 * @param {import('@restatedev/restate-sdk').Context} ctx
 * @param {{toolCallId: string, toolName: string, input: any}} call
 * @param {{tools: Record<string, ToolSpec>, loadSkill?: (name: string) => Promise<string|undefined>, step: number, index: number}} params
 */
export async function executeTool(ctx, call, { tools, loadSkill, step, index }) {
	const stepId = `${step}.${index}`
	try {
		if (call.toolName === LOAD_SKILL_TOOL && loadSkill) {
			// Journals only the reference; the body is put back into the conversation inside
			// each LLM step, never recorded (see Skills.js).
			const skillRef = await ctx.run(`skill:${call.input?.name}-${stepId}`, async () => {
				const body = await loadSkill(call.input?.name)
				return typeof body === 'string'
					? { name: call.input.name, sha256: hashSkill(body) }
					: null
			})
			return skillRef === null
				? {
						type: 'error-text',
						value: `No skill named "${call.input?.name}" is available.`,
					}
				: skillRefOutput(skillRef)
		}

		const spec = tools[call.toolName]
		if (!spec) return { type: 'error-text', value: `Unknown tool "${call.toolName}".` }

		const maxIn = spec.maxInputBytes ?? DEFAULT_TOOL_MAX_INPUT_BYTES
		const inBytes = jsonBytes(call.input)
		if (inBytes > maxIn) {
			return {
				type: 'error-text',
				value: `Tool "${call.toolName}" was not run: its arguments are ${inBytes} bytes, over the limit of ${maxIn}. Send less.`,
			}
		}
		const maxOut = spec.maxOutputBytes ?? DEFAULT_TOOL_MAX_OUTPUT_BYTES

		if (spec.approval) {
			const decision = await requestApproval(ctx, call, spec.approval)
			if (!decision.approved) {
				return {
					type: 'error-text',
					value: `Tool "${call.toolName}" was not approved: ${decision.reason ?? 'rejected'}.`,
				}
			}
		}

		const meta = { idempotencyKey: `${ctx.request().id}:${stepId}` }
		const value = spec.execute
			? await ctx.run(
					`tool:${call.toolName}-${stepId}`,
					async () => {
						const result = (await spec.execute(call.input, meta)) ?? null
						assertOutputSize(call.toolName, result, maxOut)
						return result
					},
					spec.retry ?? DEFAULT_TOOL_RETRY,
				)
			: await ctx.genericCall({
					service: targetName(spec.block),
					method: spec.handler,
					key: spec.key?.(call.input, meta),
					parameter: spec.input ? spec.input(call.input, meta) : call.input,
					inputSerde: serde.json,
					outputSerde: serde.json,
				})

		if (!spec.execute) assertOutputSize(call.toolName, value, maxOut)
		return { type: 'json', value: value ?? null }
	} catch (error) {
		if (error instanceof CancelledError || !(error instanceof TerminalError)) throw error
		return { type: 'error-text', value: error.message }
	}
}

/** @throws {TerminalError} when a tool result is too big to hand to the model or record. */
function assertOutputSize(toolName, value, max) {
	const bytes = jsonBytes(value)
	if (bytes > max) {
		throw new TerminalError(
			`Tool "${toolName}" returned ${bytes} bytes, over the limit of ${max}. Ask for less, or a part of it.`,
			{ errorCode: 413 },
		)
	}
}

/**
 * Asks for approval through an awakeable and waits for the decision, durably.
 * @param {import('@restatedev/restate-sdk').Context} ctx
 * @param {{toolName: string, input: any}} call
 * @param {ApprovalSpec} approval
 * @returns {Promise<{approved: boolean, reason?: string}>}
 */
async function requestApproval(ctx, call, { timeout, notify }) {
	const { id, promise } = ctx.awakeable()
	ctx.genericSend({
		service: targetName(notify.block),
		method: notify.handler,
		key: notify.key,
		parameter: {
			awakeableId: id,
			tool: call.toolName,
			input: call.input,
			invocationId: ctx.request().id,
		},
		inputSerde: serde.json,
	})

	let decision
	try {
		decision = await promise.orTimeout(timeout)
	} catch (error) {
		if (error instanceof TimeoutError) return { approved: false, reason: 'approval timed out' }
		throw error
	}
	return {
		approved: decision?.approved === true,
		reason: typeof decision?.reason === 'string' ? decision.reason : undefined,
	}
}

const targetName = (block) => (typeof block === 'string' ? block : block.name)
