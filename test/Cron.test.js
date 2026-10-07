import { afterEach, describe, test, expect } from 'bun:test'
import {
	cronJobInitiator,
	cronJob,
	ensureCronJob,
	setJobStateName,
	JOB_STATE_NAME,
} from '../lib/Cron.js'
import { TerminalError } from '@restatedev/restate-sdk'

describe('setJobStateName', () => {
	test('returns the name it was given', () => {
		expect(setJobStateName('empyria-job-state')).toBe('empyria-job-state')
	})

	test('defaults to "empyria-job-state"', () => {
		expect(JOB_STATE_NAME).toBe('empyria-job-state')
	})
})

describe('cronJobInitiator.create', () => {
	test('creates a job on a fresh object instance and reports its next execution time', async () => {
		const ctx = {
			rand: { uuidv4: () => 'job-uuid-1' },
			objectClient: () => ({
				initiate: async () => ({ next_execution_time: 'SOME_TIME' }),
			}),
		}
		const result = await cronJobInitiator.service.create(ctx, { cronExpression: '* * * * *' })
		expect(result).toContain('job-uuid-1')
		expect(result).toContain('SOME_TIME')
	})
})

// Every cronJob handler that schedules a next run needs the same "date/objectSendClient/set"
// wiring; this factory keeps the mocked context consistent across tests.
function makeSchedulingCtx({ existing } = {}) {
	const sets = []
	const cancelled = []
	return {
		sets,
		cancelled,
		cancel: (invocationId) => cancelled.push(invocationId),
		get: async () => existing,
		date: { now: async () => Date.now() },
		key: 'job-1',
		objectSendClient: () => ({
			execute: () => ({ invocationId: Promise.resolve('exec-inv-1') }),
		}),
		set: (key, value) => sets.push([key, value]),
	}
}

describe('cronJob.initiate', () => {
	test('schedules the first execution for a fresh job', async () => {
		const ctx = makeSchedulingCtx()
		const request = { cronExpression: '* * * * *' }

		const jobState = await cronJob.object.initiate(ctx, request)

		expect(jobState.request).toEqual(request)
		expect(jobState.next_execution_id).toBe('exec-inv-1')
		expect(ctx.sets).toEqual([[JOB_STATE_NAME, jobState]])
	})

	test('throws when a job already exists for this ID', async () => {
		const ctx = makeSchedulingCtx({ existing: { request: {} } })
		await expect(cronJob.object.initiate(ctx, { cronExpression: '* * * * *' })).rejects.toThrow(
			TerminalError,
		)
	})

	test('throws on an invalid cron expression', async () => {
		const ctx = makeSchedulingCtx()
		await expect(
			cronJob.object.initiate(ctx, { cronExpression: 'not-a-cron-expression' }),
		).rejects.toThrow(TerminalError)
	})
})

describe('cronJob.execute', () => {
	test('sends the job payload and reschedules the next execution', async () => {
		const sent = []
		const ctx = makeSchedulingCtx({
			existing: {
				request: {
					service: 'Svc',
					method: 'do',
					key: 'k',
					payload: { a: 1 },
					cronExpression: '* * * * *',
				},
			},
		})
		ctx.genericSend = (opts) => sent.push(opts)

		await cronJob.object.execute(ctx)

		expect(sent).toEqual([
			{
				service: 'Svc',
				method: 'do',
				parameter: { a: 1 },
				key: 'k',
				inputSerde: expect.anything(),
			},
		])
		// scheduleNextExecution ran again and stored a new state
		expect(ctx.sets.length).toBe(1)
	})

	test('throws when there is no job state to execute', async () => {
		const ctx = makeSchedulingCtx({ existing: undefined })
		await expect(cronJob.object.execute(ctx)).rejects.toThrow(TerminalError)
	})
})

describe('cronJob.cancel', () => {
	test('cancels the pending execution and clears state', async () => {
		const cancelled = []
		const ctx = {
			get: async () => ({ next_execution_id: 'exec-inv-1' }),
			cancel: (id) => cancelled.push(id),
			clearAll: () => {},
		}
		let cleared = false
		ctx.clearAll = () => {
			cleared = true
		}

		await cronJob.object.cancel(ctx)

		expect(cancelled).toEqual(['exec-inv-1'])
		expect(cleared).toBe(true)
	})

	test('still clears state when there is no pending execution', async () => {
		let cleared = false
		const ctx = {
			get: async () => undefined,
			cancel: () => {
				throw new Error('should not be called')
			},
			clearAll: () => {
				cleared = true
			},
		}

		await cronJob.object.cancel(ctx)

		expect(cleared).toBe(true)
	})
})

describe('cronJob.getInfo', () => {
	test('returns the current job state', async () => {
		const ctx = { get: async () => ({ request: {} }) }
		expect(await cronJob.object.getInfo(ctx)).toEqual({ request: {} })
	})
})

describe('cronJob.ensure', () => {
	const request = { cronExpression: '* * * * *', service: 'ReportService', method: 'refresh' }

	test('schedules a job that does not exist yet', async () => {
		const ctx = makeSchedulingCtx()
		const state = await cronJob.object.ensure(ctx, request)
		expect(state.request).toEqual(request)
		expect(state.next_execution_id).toBe('exec-inv-1')
		expect(ctx.sets).toEqual([[JOB_STATE_NAME, state]])
		expect(ctx.cancelled).toEqual([])
	})

	test('the same request again changes nothing: no second schedule, no cancel', async () => {
		const existing = { request, next_execution_time: 'T', next_execution_id: 'inv-old' }
		const ctx = makeSchedulingCtx({ existing })
		expect(await cronJob.object.ensure(ctx, request)).toBe(existing)
		expect(ctx.sets).toEqual([])
		expect(ctx.cancelled).toEqual([])
	})

	test('unknown fields and field order do not make a request "different"', async () => {
		const existing = { request, next_execution_time: 'T', next_execution_id: 'inv-old' }
		const ctx = makeSchedulingCtx({ existing })
		const same = {
			method: 'refresh',
			extra: 'ignored',
			service: 'ReportService',
			cronExpression: '* * * * *',
		}
		expect(await cronJob.object.ensure(ctx, same)).toBe(existing)
		expect(ctx.sets).toEqual([])
	})

	test('a changed schedule cancels the pending run and schedules the new one under the same job', async () => {
		const existing = { request, next_execution_time: 'T', next_execution_id: 'inv-old' }
		const ctx = makeSchedulingCtx({ existing })
		const state = await cronJob.object.ensure(ctx, {
			...request,
			cronExpression: '*/5 * * * *',
		})
		expect(ctx.cancelled).toEqual(['inv-old'])
		expect(state.request.cronExpression).toBe('*/5 * * * *')
		expect(ctx.sets).toHaveLength(1)
	})

	test('a changed target or payload also replaces the job', async () => {
		const existing = { request, next_execution_time: 'T', next_execution_id: 'inv-old' }
		for (const change of [{ method: 'other' }, { payload: { a: 1 } }, { key: 'k' }]) {
			const ctx = makeSchedulingCtx({ existing })
			await cronJob.object.ensure(ctx, { ...request, ...change })
			expect(ctx.cancelled).toEqual(['inv-old'])
		}
	})

	test('a request without a schedule, service or method is refused (400)', async () => {
		for (const bad of [
			{},
			{ ...request, cronExpression: '' },
			{ ...request, service: undefined },
			{ ...request, method: 3 },
		]) {
			const error = await cronJob.object.ensure(makeSchedulingCtx(), bad).catch((e) => e)
			expect(error).toBeInstanceOf(TerminalError)
			expect(error.code).toBe(400)
		}
	})

	test('an invalid cron expression is a terminal error and leaves an existing job alone', async () => {
		const ctx = makeSchedulingCtx()
		await expect(
			cronJob.object.ensure(ctx, { ...request, cronExpression: 'not a cron' }),
		).rejects.toThrow(TerminalError)
		expect(ctx.sets).toEqual([])
	})
})

describe('ensureCronJob', () => {
	const realFetch = globalThis.fetch
	afterEach(() => {
		globalThis.fetch = realFetch
	})

	test('calls CronJob/<id>/ensure through the ingress with the request as the body', async () => {
		const calls = []
		globalThis.fetch = async (url, init) => {
			calls.push([url, JSON.parse(init.body)])
			return new Response(JSON.stringify({ next_execution_time: 'T' }), { status: 200 })
		}
		const state = await ensureCronJob({
			restateURL: 'http://restate:8080',
			id: 'reports:refresh',
			cronExpression: '* * * * *',
			service: 'ReportService',
			method: 'refresh',
		})
		expect(state).toEqual({ next_execution_time: 'T' })
		expect(calls).toEqual([
			[
				'http://restate:8080/CronJob/reports:refresh/ensure',
				{ cronExpression: '* * * * *', service: 'ReportService', method: 'refresh' },
			],
		])
	})

	test('refuses an id that is not safe in a URL path', async () => {
		for (const id of ['', 'a/b', 'a b', 'a?b', undefined]) {
			await expect(
				ensureCronJob({
					restateURL: 'http://x',
					id,
					cronExpression: '* * * * *',
					service: 's',
					method: 'm',
				}),
			).rejects.toThrow(TypeError)
		}
	})

	test('a failed call is an error for the caller', async () => {
		globalThis.fetch = async () =>
			new Response('nope', { status: 500, statusText: 'Internal Server Error' })
		await expect(
			ensureCronJob({
				restateURL: 'http://x',
				id: 'j',
				cronExpression: '* * * * *',
				service: 's',
				method: 'm',
			}),
		).rejects.toThrow('500')
	})
})

describe('retry policy', () => {
	test('a job practically never gives up, so it is never paused', async () => {
		const { RETRY_FOREVER } = await import('../lib/Cron.js')
		// Omitting the limit (or Infinity) would leave the server default of 70 attempts.
		expect(RETRY_FOREVER.maxAttempts).toBe(2_147_483_647)
		expect(cronJob.options?.retryPolicy ?? cronJob.retryPolicy).toBeDefined()
	})
})
