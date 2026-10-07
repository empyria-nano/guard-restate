import { generateText } from 'ai'
import { TerminalError } from '@restatedev/restate-sdk'
import { createValidator } from '@empyria/common'
import { DEFAULT_LLM_RETRY, toRestateLLMError } from './Errors.js'
import { cachedSkillFetcher, expandSkillRefs } from './Skills.js'
import { FINAL_ANSWER_TOOL, buildToolDefs, executeTool } from './Tools.js'

const FINAL_ANSWER_NUDGE = `Respond by calling the ${FINAL_ANSWER_TOOL} tool with your answer.`

/** The text handed back to the model when its final answer does not fit the schema (kept short). */
const rejection = (message) =>
	`Your answer was not accepted because it does not match the required format: ${String(message).slice(0, 1500)}\nCall ${FINAL_ANSWER_TOOL} again with a corrected answer.`

/**
 * Drives an AI SDK Core tool-calling loop ONE round at a time, from inside a Restate
 * handler — deliberately NOT `generateText`'s own multi-step loop wrapped in a single
 * `ctx.run()`. That would make the whole loop atomic to Restate: a crash mid-loop would
 * replay it from scratch, re-billing finished LLM calls and re-executing tools that
 * already ran. Here every LLM call and every tool call is its own durable step, so a
 * crash resumes exactly where it left off, and each step shows up by name in Restate's
 * invocation UI.
 *
 * Journal discipline: an LLM step records only the model's response (text, tool calls,
 * token usage), never the prompt it was sent. Prior conversation comes from
 * `loadHistory`, which is called inside each LLM step — so it must return the same
 * messages every time it's called during one invocation (e.g. load an immutable
 * snapshot by reference). Loaded skills work the same way: the journal holds a
 * reference and hash, and the body is fetched again inside each LLM step (see Skills.js).
 * @param {import('@restatedev/restate-sdk').Context} ctx
 * @param {{
 *   model: import('@ai-sdk/provider').LanguageModelV4,
 *   system: string,
 *   prompt: string,
 *   tools?: Record<string, import('./Tools.js').ToolSpec>,
 *   skills?: Array<{name: string, description: string}>,
 *   loadSkill?: (name: string) => Promise<string|undefined>,
 *   loadHistory?: () => Promise<Array<object>>,
 *   outputSchema?: object,
 *   maxSteps?: number,
 *   maxTokens?: number,
 *   retry?: import('@restatedev/restate-sdk').RunOptions<any>,
 * }} params `skills` is the index only (name + description); `loadSkill` fetches a body
 *   when the model asks for it. With `outputSchema`, the model must answer through the
 *   `final_answer` tool and the loop returns that tool's input as `output`, after checking it against the
 *   schema: an answer that does not fit is handed back to the model to correct, not accepted.
 * @returns {Promise<{text: string, output?: unknown, steps: number, totalTokens: number, trace: Array<StepTrace>, messages: Array<object>}>}
 *   `messages` are the new messages of this turn only (prompt, responses, tool results).
 *   `trace` has one small entry per LLM step. The same facts are recorded in the journal with each
 *   `llm-step-N` (as `meta`) and logged through `ctx.console`, which stays silent on replay.
 *
 * @typedef {Object} StepTrace What one LLM step did, with nothing from the prompt or the reply.
 * @property {number} step
 * @property {string} [model] The model ID as the provider reports it.
 * @property {string} [finishReason] `stop`, `tool-calls`, `length`, ...
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {number} [durationMs] Wall-clock time of the model call.
 * @property {string[]} tools Names of the tools the model asked for in this step.
 */
export async function runAgentLoop(
	ctx,
	{
		model,
		system,
		prompt,
		tools = {},
		skills = [],
		loadSkill,
		loadHistory = async () => [],
		outputSchema,
		maxSteps = 8,
		maxTokens,
		retry = DEFAULT_LLM_RETRY,
	},
) {
	const fullSystem = buildSystemPrompt(system, skills)
	const toolDefs = buildToolDefs({ tools, hasSkills: skills.length > 0, outputSchema })
	const messages = [{ role: 'user', content: prompt }]
	let totalTokens = 0
	const fetchSkill = cachedSkillFetcher(loadSkill)
	const validateOutput = outputSchema ? createValidator(outputSchema) : undefined
	const trace = []

	for (let step = 0; step < maxSteps; step++) {
		// `ctx.run` JSON-serialises the callback's result for the journal and hands back that
		// copy. AI SDK's `response` is a non-enumerable getter `JSON.stringify` drops, so the
		// plain fields the loop needs are extracted inside the callback.
		const result = await ctx.run(
			`llm-step-${step}`,
			async () => {
				const startedAt = Date.now()
				try {
					// `maxRetries: 0`: `ctx.run`'s RunOptions are the single retry authority,
					// instead of AI SDK's own retries stacking invisibly underneath them.
					const r = await generateText({
						model,
						system: fullSystem,
						messages: [
							...(await expandSkillRefs(await loadHistory(), {
								fetchSkill,
								strict: false,
							})),
							...(await expandSkillRefs(messages, { fetchSkill, strict: true })),
						],
						tools: toolDefs,
						maxRetries: 0,
					})
					return {
						text: r.text,
						toolCalls: r.toolCalls.map(({ toolCallId, toolName, input }) => ({
							toolCallId,
							toolName,
							input,
						})),
						responseMessages: r.response.messages,
						totalTokens: r.usage?.totalTokens ?? 0,
						// A few numbers: enough to see whether the step worked, and what it cost.
						meta: {
							model: model.modelId,
							finishReason: r.finishReason,
							inputTokens: r.usage?.inputTokens,
							outputTokens: r.usage?.outputTokens,
							durationMs: Date.now() - startedAt,
						},
					}
				} catch (error) {
					throw toRestateLLMError(error)
				}
			},
			retry,
		)

		const entry = { step, ...result.meta, tools: result.toolCalls.map((call) => call.toolName) }
		trace.push(entry)
		// `ctx.console` is replay-aware: one line per step, never repeated when Restate replays.
		ctx.console?.log(
			`llm-step-${step} model=${entry.model ?? '?'} finish=${entry.finishReason ?? '?'} in=${entry.inputTokens ?? '?'} out=${entry.outputTokens ?? '?'} ${entry.durationMs ?? '?'}ms tools=[${entry.tools.join(',')}]`,
		)

		messages.push(...result.responseMessages)
		totalTokens += result.totalTokens
		if (maxTokens !== undefined && totalTokens > maxTokens) {
			throw new TerminalError(
				`Agent exceeded its token budget (${totalTokens} > ${maxTokens})`,
				{ errorCode: 429 },
			)
		}

		if (result.toolCalls.length === 0) {
			if (!outputSchema) {
				return { text: result.text, steps: step + 1, totalTokens, trace, messages }
			}
			messages.push({ role: 'user', content: FINAL_ANSWER_NUDGE })
			continue
		}

		for (const [index, call] of result.toolCalls.entries()) {
			if (outputSchema && call.toolName === FINAL_ANSWER_TOOL) {
				let output
				try {
					output = validateOutput(call.input)
				} catch (error) {
					// The model's arguments are not checked by the provider. Tell it what is wrong and let it
					// answer again; this uses a step, so a model that cannot get it right ends at maxSteps.
					messages.push({
						role: 'tool',
						content: [
							{
								type: 'tool-result',
								toolCallId: call.toolCallId,
								toolName: call.toolName,
								output: { type: 'error-text', value: rejection(error.message) },
							},
						],
					})
					continue
				}
				return { text: result.text, output, steps: step + 1, totalTokens, trace, messages }
			}
			const output = await executeTool(ctx, call, { tools, loadSkill, step, index })
			messages.push({
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: call.toolCallId,
						toolName: call.toolName,
						output,
					},
				],
			})
		}
	}

	// Exceeding maxSteps isn't a transient fault a retry could fix.
	throw new TerminalError(`Agent loop exceeded maxSteps (${maxSteps}) without a final answer`)
}

function buildSystemPrompt(system, skills) {
	if (skills.length === 0) return system

	const index = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
	const instructions = `Available skills — call load_skill with a skill's name to read its full instructions before following them:\n${index}`
	return [system, instructions].filter(Boolean).join('\n\n')
}
