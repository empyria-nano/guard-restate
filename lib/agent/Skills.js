import { createHash } from 'node:crypto'
import { TerminalError } from '@restatedev/restate-sdk'

export const LOAD_SKILL_TOOL = 'load_skill'

/**
 * @typedef {{name: string, sha256: string}} SkillRef What the journal records for a loaded
 *   skill instead of its body.
 */

/** @param {string} body */
export const hashSkill = (body) => createHash('sha256').update(body).digest('hex')

/**
 * The `load_skill` tool result as it's journaled and kept in history: a reference only.
 * {@link expandSkillRefs} turns it back into the body right before each model call.
 * @param {SkillRef} skillRef
 */
export const skillRefOutput = (skillRef) => ({ type: 'json', value: { skillRef } })

/**
 * Returns a copy of `messages` with every `load_skill` reference replaced by the skill's
 * body. Called inside each LLM step's `ctx.run`, whose input is never journaled — so skill
 * bodies never reach the journal, only the {@link SkillRef}s do.
 *
 * `strict` is for references recorded in the current invocation: the body must hash to the
 * recorded value, otherwise the skill changed between the original execution and a replay,
 * and the model would silently see different instructions than before — a `TerminalError`.
 * Non-strict is for references from earlier turns of a session: a skill updated between
 * turns is legitimate, so the current body is used, or a notice if the skill is gone.
 * @param {Array<object>} messages
 * @param {{fetchSkill?: (name: string) => Promise<string|undefined>, strict: boolean}} params
 * @returns {Promise<Array<object>>}
 */
export async function expandSkillRefs(messages, { fetchSkill, strict }) {
	return Promise.all(
		messages.map(async (message) => {
			if (message.role !== 'tool' || !Array.isArray(message.content)) return message
			return {
				...message,
				content: await Promise.all(
					message.content.map((part) => expandPart(part, { fetchSkill, strict })),
				),
			}
		}),
	)
}

async function expandPart(part, { fetchSkill, strict }) {
	const skillRef = part.type === 'tool-result' && part.output?.value?.skillRef
	if (part.toolName !== LOAD_SKILL_TOOL || !skillRef) return part

	const body = (await fetchSkill?.(skillRef.name)) ?? undefined
	if (body !== undefined && (!strict || hashSkill(body) === skillRef.sha256)) {
		return { ...part, output: { type: 'text', value: body } }
	}
	if (strict) {
		throw new TerminalError(
			`Skill "${skillRef.name}" changed or disappeared during this invocation; refusing to send the model different instructions than it saw before`,
		)
	}
	return {
		...part,
		output: { type: 'error-text', value: `Skill "${skillRef.name}" is no longer available.` },
	}
}

/**
 * Memoises `loadSkill` for one execution of the handler. A replay starts a new execution
 * and so a fresh cache; the hash check in {@link expandSkillRefs} catches content that
 * changed in between.
 * @param {(name: string) => Promise<string|undefined>} [loadSkill]
 */
export function cachedSkillFetcher(loadSkill) {
	if (!loadSkill) return undefined
	const cache = new Map()
	return (name) => {
		if (!cache.has(name)) cache.set(name, Promise.resolve(loadSkill(name)))
		return cache.get(name)
	}
}
