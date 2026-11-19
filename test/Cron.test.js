import { afterEach, describe, test, expect } from 'bun:test'
import {
	cronJobInitiator,
	cronJob,
	defineCronJob,
	defineCronJobInitiator,
	RETRY_FOREVER,
	ensureCronJob,
	getCronJob,
	cancelCronJob,
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

describe('getCronJob and cancelCronJob', () => {
	const realFetch = globalThis.fetch
	afterEach(() => {
		globalThis.fetch = realFetch
	})
	const respond = (script) => {
		const calls = []
		globalThis.fetch = async (url) => {
			calls.push(url)
			const body = script.shift()
			return new Response(body === undefined ? '' : JSON.stringify(body), { status: 200 })
		}
		return calls
	}

	test('getCronJob answers null when the job does not exist', async () => {
		respond([undefined])
		expect(await getCronJob({ restateURL: 'http://r', id: 'a:1' })).toBeNull()
	})

	test('cancelCronJob cancels, then reads the job back before it resolves', async () => {
		const calls = respond([undefined, undefined])
		await cancelCronJob({ restateURL: 'http://r', id: 'a:1' })
		expect(calls).toEqual(['http://r/CronJob/a:1/cancel', 'http://r/CronJob/a:1/getInfo'])
	})

	test('cancelCronJob fails when the job is still there afterwards', async () => {
		respond([undefined, { request: {} }])
		expect(cancelCronJob({ restateURL: 'http://r', id: 'a:1' })).rejects.toThrow(
			'still scheduled',
		)
	})

	test('cancelCronJob fails when the cancel call fails', async () => {
		globalThis.fetch = async () => new Response('', { status: 503, statusText: 'down' })
		expect(cancelCronJob({ restateURL: 'http://r', id: 'a:1' })).rejects.toThrow('503')
	})

	test('cancelCronJob refuses an id that cannot be a job id', () => {
		expect(cancelCronJob({ restateURL: 'http://r', id: 'a b' })).rejects.toThrow(TypeError)
	})
})

describe('defineCronJob', () => {
	const request = { cronExpression: '* * * * *', service: 'ReportService', method: 'refresh' }
	// Records which object each scheduled run is sent to.
	const trackSends = (ctx) => {
		const targets = []
		ctx.objectSendClient = (definition, key) => {
			targets.push([definition.name, key])
			return { execute: () => ({ invocationId: Promise.resolve('exec-inv-1') }) }
		}
		return targets
	}

	test('the default instance is unchanged: CronJob, the same handlers, retry policy and state key', async () => {
		expect(cronJob.name).toBe('CronJob')
		expect(Object.keys(cronJob.object).sort()).toEqual([
			'cancel',
			'ensure',
			'execute',
			'getInfo',
			'initiate',
		])
		expect(cronJob.options).toEqual({ retryPolicy: RETRY_FOREVER })

		const made = defineCronJob()
		expect(made.name).toBe('CronJob')
		expect(made.options).toEqual({ retryPolicy: RETRY_FOREVER })

		const ctx = makeSchedulingCtx()
		const targets = trackSends(ctx)
		const state = await cronJob.object.initiate(ctx, request)
		expect(targets).toEqual([['CronJob', 'job-1']])
		expect(ctx.sets).toEqual([['empyria-job-state', state]])
	})

	test('a custom name is the name of the definition', () => {
		const reports = defineCronJob({ name: 'ReportCron' })
		expect(reports.name).toBe('ReportCron')
		expect(Object.keys(reports.object).sort()).toEqual(Object.keys(cronJob.object).sort())
	})

	test('a custom name is where the next run is sent, from initiate, ensure and execute', async () => {
		const reports = defineCronJob({ name: 'ReportCron' })

		for (const call of [
			(ctx) => reports.object.initiate(ctx, request),
			(ctx) => reports.object.ensure(ctx, request),
		]) {
			const ctx = makeSchedulingCtx()
			const targets = trackSends(ctx)
			await call(ctx)
			expect(targets).toEqual([['ReportCron', 'job-1']])
		}

		const ctx = makeSchedulingCtx({ existing: { request } })
		ctx.genericSend = () => {}
		const targets = trackSends(ctx)
		await reports.object.execute(ctx)
		expect(targets).toEqual([['ReportCron', 'job-1']])
	})

	test('two cron objects never cross: each sends to itself', async () => {
		const a = defineCronJob({ name: 'CronA' })
		const b = defineCronJob({ name: 'CronB' })
		const ctxA = makeSchedulingCtx()
		const ctxB = makeSchedulingCtx()
		const targetsA = trackSends(ctxA)
		const targetsB = trackSends(ctxB)
		await a.object.initiate(ctxA, request)
		await b.object.initiate(ctxB, request)
		await cronJob.object.initiate(ctxA, request)
		expect(targetsA).toEqual([
			['CronA', 'job-1'],
			['CronJob', 'job-1'],
		])
		expect(targetsB).toEqual([['CronB', 'job-1']])
	})

	test('custom options are merged with the never-give-up retry policy', () => {
		const made = defineCronJob({ name: 'ReportCron', options: { inactivityTimeout: 60_000 } })
		expect(made.options).toEqual({ retryPolicy: RETRY_FOREVER, inactivityTimeout: 60_000 })
	})

	test('an explicit retryPolicy wins', () => {
		const retryPolicy = { maxAttempts: 3, onMaxAttempts: 'kill' }
		const made = defineCronJob({ options: { retryPolicy, inactivityTimeout: 60_000 } })
		expect(made.options).toEqual({ retryPolicy, inactivityTimeout: 60_000 })
		// The default instance is not touched by another instance's options.
		expect(cronJob.options).toEqual({ retryPolicy: RETRY_FOREVER })
	})

	test('jobStateName is the state key of that instance only', async () => {
		const reports = defineCronJob({ name: 'ReportCron', jobStateName: 'report-job' })
		const keys = []
		const ctx = makeSchedulingCtx()
		ctx.get = async (key) => {
			keys.push(key)
			return undefined
		}
		const state = await reports.object.initiate(ctx, request)
		expect(keys).toEqual(['report-job'])
		expect(ctx.sets).toEqual([['report-job', state]])

		const read = []
		await reports.object.getInfo({ get: async (key) => read.push(key) })
		await cronJob.object.getInfo({ get: async (key) => read.push(key) })
		expect(read).toEqual(['report-job', 'empyria-job-state'])
	})

	test('without a jobStateName the module-level name is read on every call', async () => {
		const made = defineCronJob({ name: 'ReportCron' })
		const read = []
		const ctx = { get: async (key) => read.push(key) }
		try {
			setJobStateName('renamed-state')
			await made.object.getInfo(ctx)
			await cronJob.object.getInfo(ctx)
		} finally {
			setJobStateName('empyria-job-state')
		}
		await cronJob.object.getInfo(ctx)
		expect(read).toEqual(['renamed-state', 'renamed-state', 'empyria-job-state'])
	})

	test('a name that cannot be a Restate object name, or an empty state key, is refused', () => {
		for (const name of ['', 'a/b', 'a b', '1abc', 3, null]) {
			expect(() => defineCronJob({ name })).toThrow(TypeError)
		}
		for (const jobStateName of ['', 3, null]) {
			expect(() => defineCronJob({ jobStateName })).toThrow(TypeError)
		}
	})
})

describe('defineCronJobInitiator', () => {
	const makeCtx = () => {
		const targets = []
		return {
			targets,
			rand: { uuidv4: () => 'job-uuid-1' },
			objectClient: (definition, key) => {
				targets.push([definition.name, key])
				return { initiate: async () => ({ next_execution_time: 'SOME_TIME' }) }
			},
		}
	}

	test('the default instance is CronJobInitiator and creates jobs on CronJob', async () => {
		expect(cronJobInitiator.name).toBe('CronJobInitiator')
		expect(defineCronJobInitiator().name).toBe('CronJobInitiator')
		const ctx = makeCtx()
		await cronJobInitiator.service.create(ctx, { cronExpression: '* * * * *' })
		expect(ctx.targets).toEqual([['CronJob', 'job-uuid-1']])
	})

	test('a custom name and cron object are used', async () => {
		const reports = defineCronJob({ name: 'ReportCron' })
		const initiator = defineCronJobInitiator({ name: 'ReportCronInitiator', cronJob: reports })
		expect(initiator.name).toBe('ReportCronInitiator')
		const ctx = makeCtx()
		const result = await initiator.service.create(ctx, { cronExpression: '* * * * *' })
		expect(ctx.targets).toEqual([['ReportCron', 'job-uuid-1']])
		expect(result).toContain('job-uuid-1')
	})

	test('a bad name or cron object is refused', () => {
		expect(() => defineCronJobInitiator({ name: 'a/b' })).toThrow(TypeError)
		expect(() => defineCronJobInitiator({ cronJob: {} })).toThrow(TypeError)
		expect(() => defineCronJobInitiator({ cronJob: null })).toThrow(TypeError)
	})
})

describe('the ingress helpers and the cron object name', () => {
	const realFetch = globalThis.fetch
	afterEach(() => {
		globalThis.fetch = realFetch
	})
	const record = (script = []) => {
		const calls = []
		globalThis.fetch = async (url, init) => {
			calls.push([url, init.body === undefined ? undefined : JSON.parse(init.body)])
			const body = script.shift()
			return new Response(body === undefined ? '' : JSON.stringify(body), { status: 200 })
		}
		return calls
	}
	const request = { cronExpression: '* * * * *', service: 'ReportService', method: 'refresh' }

	test('ensureCronJob sends to the given name and keeps the name out of the request', async () => {
		const calls = record([{ next_execution_time: 'T' }])
		await ensureCronJob({ restateURL: 'http://r', id: 'a:1', name: 'ReportCron', ...request })
		expect(calls).toEqual([['http://r/ReportCron/a:1/ensure', request]])
	})

	test('ensureCronJob sends to CronJob by default', async () => {
		const calls = record([{ next_execution_time: 'T' }])
		await ensureCronJob({ restateURL: 'http://r', id: 'a:1', ...request, key: 'k', payload: 1 })
		expect(calls).toEqual([
			['http://r/CronJob/a:1/ensure', { ...request, key: 'k', payload: 1 }],
		])
	})

	test('getCronJob asks the given name, and CronJob by default', async () => {
		const calls = record([{ request }, { request }])
		expect(await getCronJob({ restateURL: 'http://r', id: 'a:1', name: 'ReportCron' })).toEqual(
			{
				request,
			},
		)
		await getCronJob({ restateURL: 'http://r', id: 'a:1' })
		expect(calls.map(([url]) => url)).toEqual([
			'http://r/ReportCron/a:1/getInfo',
			'http://r/CronJob/a:1/getInfo',
		])
	})

	test('cancelCronJob cancels and reads back on the given name, and on CronJob by default', async () => {
		const calls = record()
		await cancelCronJob({ restateURL: 'http://r', id: 'a:1', name: 'ReportCron' })
		await cancelCronJob({ restateURL: 'http://r', id: 'a:1' })
		expect(calls.map(([url]) => url)).toEqual([
			'http://r/ReportCron/a:1/cancel',
			'http://r/ReportCron/a:1/getInfo',
			'http://r/CronJob/a:1/cancel',
			'http://r/CronJob/a:1/getInfo',
		])
	})

	test('a name that is not safe in a URL path throws a TypeError and nothing is sent', async () => {
		const calls = record()
		for (const name of ['', 'a/b', 'a b', 'a?b', '../x', 3, null]) {
			await expect(
				ensureCronJob({ restateURL: 'http://r', id: 'a:1', name, ...request }),
			).rejects.toThrow(TypeError)
			await expect(getCronJob({ restateURL: 'http://r', id: 'a:1', name })).rejects.toThrow(
				TypeError,
			)
			await expect(
				cancelCronJob({ restateURL: 'http://r', id: 'a:1', name }),
			).rejects.toThrow(TypeError)
		}
		expect(calls).toEqual([])
	})
})
