import { describe, test, expect } from 'bun:test'
import { cronJobInitiator, cronJob, setJobStateName, JOB_STATE_NAME } from '../lib/Cron.js'
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
	return {
		sets,
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
