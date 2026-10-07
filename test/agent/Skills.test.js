import { describe, test, expect } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { TerminalError } from '@restatedev/restate-sdk'
import {
	cachedSkillFetcher,
	expandSkillRefs,
	hashSkill,
	skillRefOutput,
} from '../../lib/agent/Skills.js'
import { runAgentLoop } from '../../lib/agent/Loop.js'
import { fakeCtx, sequence, textResult, toolCallResult } from './fakes.js'

const skillMessage = (body) => ({
	role: 'tool',
	content: [
		{
			type: 'tool-result',
			toolCallId: 'call_0',
			toolName: 'load_skill',
			output: skillRefOutput({ name: 'summarise', sha256: hashSkill(body) }),
		},
	],
})
const fetchFrom = (skills) => async (name) => skills[name]

describe('expandSkillRefs', () => {
	test('replaces a reference with the body when the hash matches', async () => {
		const [expanded] = await expandSkillRefs([skillMessage('v1')], {
			fetchSkill: fetchFrom({ summarise: 'v1' }),
			strict: true,
		})
		expect(expanded.content[0].output).toEqual({ type: 'text', value: 'v1' })
	})

	test('leaves other messages and tool results untouched', async () => {
		const messages = [
			{ role: 'user', content: 'hi' },
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'c',
						toolName: 'echo',
						output: { type: 'json', value: 1 },
					},
				],
			},
		]
		expect(
			await expandSkillRefs(messages, { fetchSkill: fetchFrom({}), strict: true }),
		).toEqual(messages)
	})

	test('strict: a changed or missing skill is terminal', async () => {
		for (const skills of [{ summarise: 'v2' }, {}]) {
			await expect(
				expandSkillRefs([skillMessage('v1')], {
					fetchSkill: fetchFrom(skills),
					strict: true,
				}),
			).rejects.toBeInstanceOf(TerminalError)
		}
	})

	test('lenient: a changed skill uses the current body; a missing one becomes a notice', async () => {
		const [changed] = await expandSkillRefs([skillMessage('v1')], {
			fetchSkill: fetchFrom({ summarise: 'v2' }),
			strict: false,
		})
		expect(changed.content[0].output).toEqual({ type: 'text', value: 'v2' })

		const [missing] = await expandSkillRefs([skillMessage('v1')], {
			fetchSkill: undefined,
			strict: false,
		})
		expect(missing.content[0].output).toEqual({
			type: 'error-text',
			value: 'Skill "summarise" is no longer available.',
		})
	})
})

describe('cachedSkillFetcher', () => {
	test('fetches each skill once per execution', async () => {
		let fetches = 0
		const fetchSkill = cachedSkillFetcher(async () => {
			fetches++
			return 'body'
		})
		await fetchSkill('a')
		await fetchSkill('a')
		await fetchSkill('b')
		expect(fetches).toBe(2)
	})

	test('is undefined without a loader', () => {
		expect(cachedSkillFetcher(undefined)).toBeUndefined()
	})
})

describe('runAgentLoop with skills', () => {
	const skills = [{ name: 'summarise', description: 'Summarise' }]

	test('the model sees the body; the journal holds only the reference', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({
			doGenerate: sequence(
				toolCallResult([{ toolName: 'load_skill', input: { name: 'summarise' } }]),
				textResult('done'),
			),
		})

		const result = await runAgentLoop(ctx, {
			model,
			system: '',
			prompt: 'hi',
			skills,
			loadSkill: async () => 'FULL SKILL BODY',
		})

		expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('FULL SKILL BODY')
		expect(JSON.stringify(ctx.steps.map((s) => s.result))).not.toContain('FULL SKILL BODY')
		expect(JSON.stringify(result.messages)).not.toContain('FULL SKILL BODY')
	})

	test('a skill that changes mid-invocation fails the step instead of changing the instructions', async () => {
		let version = 0
		const model = new MockLanguageModelV4({
			doGenerate: sequence(
				toolCallResult([{ toolName: 'load_skill', input: { name: 'summarise' } }]),
				textResult('done'),
			),
		})

		await expect(
			runAgentLoop(fakeCtx(), {
				model,
				system: '',
				prompt: 'hi',
				skills,
				// The journaled hash is taken from v1; the next LLM step fetches v2.
				loadSkill: async () => `v${++version}`,
			}),
		).rejects.toThrow(/changed or disappeared/)
	})
})
