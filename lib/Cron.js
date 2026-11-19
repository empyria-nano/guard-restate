import * as restate from '@restatedev/restate-sdk'
import { TerminalError, serde } from '@restatedev/restate-sdk'
import { Cron } from 'croner'
import { sendMessage } from './Admin.js'
import { withTracing } from './Telemetry.js'

let JOB_STATE_NAME = 'empyria-job-state'

/**
 * Changes the state key the default cron job object (and any `defineCronJob` instance without a `jobStateName` of
 * its own) stores a job under. Jobs stored under the old key are not moved.
 * @param {string} jobStateName
 * @returns {string} the name now in use
 */
export const setJobStateName = (jobStateName) => {
	JOB_STATE_NAME = jobStateName
	return JOB_STATE_NAME
}

/**
 * A retry policy that practically never gives up: it backs off to one attempt a minute and keeps trying. Left to
 * itself Restate stops after 70 attempts (about an hour at this pace) and *pauses* the invocation, and a paused
 * invocation of a virtual object holds the object's lock, so every later call queues behind it for ever. A schedule
 * that was due while the services were down (a restart, a crash, a night off) must simply run when they are back, so
 * jobs use this.
 *
 * The attempt limit is the largest the server accepts. Leaving `maxAttempts` out, or setting it to `Infinity`, does
 * not mean unlimited: the server then applies its own default of 70.
 */
export const RETRY_FOREVER = {
	maxAttempts: 2_147_483_647,
	initialInterval: { seconds: 1 },
	maxInterval: { minutes: 1 },
	exponentiationFactor: 2,
}

/** The name the default cron job object is registered under. */
const DEFAULT_CRON_JOB_NAME = 'CronJob'
/** The name the default initiator service is registered under. */
const DEFAULT_CRON_JOB_INITIATOR_NAME = 'CronJobInitiator'

/** A Restate service or object name, which is also one segment of the ingress path. */
const checkName = (fn, name) => {
	if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9._-]*$/.test(name)) {
		throw new TypeError(
			`${fn} needs a name that starts with a letter or "_" and has only letters, digits, ".", "_" and "-"`,
		)
	}
}

/**
 * Makes a cron job virtual object: one object instance (key) is one recurring job. Use it when the default
 * {@link cronJob} does not fit: to register the object under another name, or to give it other Restate options.
 * Several differently named cron objects may live on one endpoint; each schedules its runs on itself, so they never
 * cross.
 *
 * Handlers: `initiate` (create, fails when the job exists), `ensure` (idempotent create or replace), `execute` (one
 * run, then schedule the next; called by the object on itself), `cancel` and `getInfo` (shared).
 * @param {object} [params]
 * @param {string} [params.name] the object's name in Restate (default `CronJob`). Pass the same name to
 *   `ensureCronJob`/`getCronJob`/`cancelCronJob`.
 * @param {object} [params.options] Restate object options (retry policy, timeouts, retention...), merged over
 *   `{ retryPolicy: RETRY_FOREVER }`: the never-give-up retry policy stays unless `retryPolicy` is given here.
 * @param {string} [params.jobStateName] the state key the job is stored under. Default: the module-level name
 *   (`empyria-job-state`, or what `setJobStateName` set), read on every call.
 * @returns {import('@restatedev/restate-sdk').VirtualObjectDefinition<string, any>}
 * @throws {TypeError} when `name` cannot be a Restate object name, or `jobStateName` is not a non-empty string
 */
export function defineCronJob({ name = DEFAULT_CRON_JOB_NAME, options, jobStateName } = {}) {
	checkName('defineCronJob', name)
	if (jobStateName !== undefined && (typeof jobStateName !== 'string' || jobStateName === '')) {
		throw new TypeError('defineCronJob needs jobStateName to be a non-empty string')
	}

	// Read on every call, so setJobStateName still reaches an instance without a state key of its own.
	const stateName = () => jobStateName ?? JOB_STATE_NAME
	// The next run is sent to this very object, whatever it is named.
	const schedule = (ctx, request) => scheduleNextExecution(ctx, request, definition, stateName())

	const definition = restate.object(
		withTracing({
			name,
			options: { retryPolicy: RETRY_FOREVER, ...options },
			handlers: {
				initiate: async (ctx, request) => {
					if (await ctx.get(stateName())) {
						throw new TerminalError('Job already exists for this ID.')
					}

					return await schedule(ctx, request)
				},
				/**
				 * Makes sure this job exists and runs the given request: an idempotent `initiate`, meant for
				 * code that starts with the application and cannot know whether the job was created before.
				 *
				 * - no job yet: schedules it, as `initiate` does;
				 * - the same request already scheduled: changes nothing and returns the current state;
				 * - a different request (another schedule, target or payload): cancels the pending run and
				 *   schedules the new request under the same job ID.
				 */
				ensure: async (ctx, request) => {
					const wanted = normalizeRequest(request)
					const jobState = await ctx.get(stateName())

					if (jobState && sameRequest(jobState.request, wanted)) return jobState
					if (jobState) ctx.cancel(jobState.next_execution_id)

					return await schedule(ctx, wanted)
				},
				execute: async (ctx) => {
					const jobState = await ctx.get(stateName())
					if (!jobState) {
						throw new TerminalError('Job not found.')
					}

					// execute the task
					const { service, method, key, payload } = jobState.request
					if (payload) {
						ctx.genericSend({
							service,
							method,
							parameter: payload,
							key,
							inputSerde: serde.json,
						})
					} else {
						ctx.genericSend({
							service,
							method,
							parameter: undefined,
							key,
							inputSerde: serde.empty,
						})
					}

					await schedule(ctx, jobState.request)
				},
				cancel: async (ctx) => {
					// Cancel the next execution
					const jobState = await ctx.get(stateName())
					if (jobState) {
						ctx.cancel(jobState.next_execution_id)
					}

					// Clear the job state
					ctx.clearAll()
				},
				getInfo: restate.handlers.object.shared(async (ctx) => {
					return ctx.get(stateName())
				}),
			},
		}),
	)
	return definition
}

/**
 * The default cron job object: `defineCronJob()`, registered as `CronJob` with the never-give-up retry policy.
 * Register it on an endpoint to use `ensureCronJob`/`getCronJob`/`cancelCronJob` without a `name`.
 */
export const cronJob = defineCronJob()

/**
 * Makes the service that creates jobs with a random ID: its `create(request)` starts a new job on the given cron
 * object on every call. Not for code that runs on every start; use `ensure` (`ensureCronJob`) there.
 * @param {object} [params]
 * @param {string} [params.name] the service's name in Restate (default `CronJobInitiator`)
 * @param {{name: string}} [params.cronJob] the cron object the jobs are created on: a definition from
 *   {@link defineCronJob} (default: {@link cronJob})
 * @returns {import('@restatedev/restate-sdk').ServiceDefinition<string, any>}
 * @throws {TypeError} when `name` or the cron object's name cannot be a Restate service name
 */
export function defineCronJobInitiator({
	name = DEFAULT_CRON_JOB_INITIATOR_NAME,
	cronJob: target = cronJob,
} = {}) {
	checkName('defineCronJobInitiator', name)
	checkName('defineCronJobInitiator (cronJob)', target?.name)

	return restate.service(
		withTracing({
			name,
			handlers: {
				create: async (ctx, request) => {
					// Create a new job ID and initiate the cron job object for that ID
					// We can then address this job object by its ID
					const jobId = ctx.rand.uuidv4()
					const job = await ctx.objectClient(target, jobId).initiate(request)
					return `Job created with ID ${jobId} and next execution time ${job.next_execution_time}`
				},
			},
		}),
	)
}

/** The default initiator: `defineCronJobInitiator()`, registered as `CronJobInitiator` and creating jobs on {@link cronJob}. */
export const cronJobInitiator = defineCronJobInitiator()

const REQUEST_FIELDS = ['cronExpression', 'service', 'method', 'key', 'payload']

/** Keeps only the fields a job request has, and checks the required ones. */
function normalizeRequest(request) {
	const out = {}
	for (const field of REQUEST_FIELDS)
		if (request?.[field] !== undefined) out[field] = request[field]
	for (const field of ['cronExpression', 'service', 'method']) {
		if (typeof out[field] !== 'string' || out[field].trim() === '') {
			throw new TerminalError(`A cron job needs a non-empty "${field}".`, { errorCode: 400 })
		}
	}
	return out
}

const sameRequest = (a, b) =>
	JSON.stringify(REQUEST_FIELDS.map((f) => a?.[f] ?? null)) ===
	JSON.stringify(REQUEST_FIELDS.map((f) => b?.[f] ?? null))

const scheduleNextExecution = async (ctx, request, definition, stateName) => {
	// Parse cron expression
	// Persist current date in Restate for deterministic replay
	const currentDate = await ctx.date.now()
	let next
	try {
		next = new Cron(request.cronExpression).nextRun(new Date(currentDate))
	} catch (e) {
		throw new TerminalError(`Invalid cron expression: ${e.message}`)
	}
	if (!next) {
		throw new TerminalError(`Cron expression '${request.cronExpression}' has no future run`)
	}

	const delay = next.getTime() - currentDate

	// Schedule next execution for this job
	const thisJobId = ctx.key // Generated by the initiator, or given to `ensure`
	const handle = ctx
		.objectSendClient(definition, thisJobId)
		.execute(restate.rpc.sendOpts({ delay }))

	// Store the job information
	const jobState = {
		request,
		next_execution_time: next.toString(),
		// The same instant in ms since 1970, for callers that store or compare it.
		next_execution_at: next.getTime(),
		next_execution_id: await handle.invocationId,
	}
	ctx.set(stateName, jobState)
	return jobState
}

/**
 * Makes sure a recurring job exists, from outside Restate (typically right after the service registered).
 * Safe to call on every start: the job has a stable ID, so a repeat call changes nothing and a changed
 * request replaces the old schedule instead of adding a second job.
 *
 * Needs the cron job object (`cronJob`, or one from `defineCronJob`) registered on an endpoint.
 * @param {{restateURL: string, id: string, name?: string, cronExpression: string, service: string, method: string, key?: string, payload?: any}} params
 *   `id` names the job (letters, digits, `.`, `_`, `:`, `-`); `name` is the cron object to talk to (default
 *   `CronJob`), and is not part of the request; `service`/`method`/`key` are the target the job calls on each run,
 *   with `payload` as its input (none when omitted).
 * @returns {Promise<{request: object, next_execution_time: string, next_execution_at: number, next_execution_id: string}>}
 * @throws {TypeError} when `id` or `name` is not usable
 */
export async function ensureCronJob({ restateURL, id, name = DEFAULT_CRON_JOB_NAME, ...request }) {
	checkJobId('ensureCronJob', id)
	checkName('ensureCronJob', name)
	return sendMessage({
		restateURL,
		name,
		message: 'ensure',
		key: id,
		payload: request,
	})
}

const checkJobId = (fn, id) => {
	if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(id)) {
		throw new TypeError(`${fn} needs an id made of letters, digits, ".", "_", ":" and "-"`)
	}
}

/**
 * What a recurring job is doing now, from outside Restate: its request and next run, or `null` when no such job
 * exists (never created, or cancelled).
 * @param {{restateURL: string, id: string, name?: string}} params `name` is the cron object to ask (default `CronJob`)
 * @throws {TypeError} when `id` or `name` is not usable
 */
export async function getCronJob({ restateURL, id, name = DEFAULT_CRON_JOB_NAME }) {
	checkJobId('getCronJob', id)
	checkName('getCronJob', name)
	return (await sendMessage({ restateURL, name, message: 'getInfo', key: id })) ?? null
}

/**
 * Cancels a recurring job and checks that it is gone: the pending run is cancelled and the job's state cleared, then
 * the job is read back. Resolves only when the job really does not exist any more, so a caller may act on it (for
 * example move a card) without a second look. Safe to repeat, and safe for a job that never existed.
 * @param {{restateURL: string, id: string, name?: string}} params `name` is the cron object the job lives on
 *   (default `CronJob`)
 * @returns {Promise<void>}
 * @throws {TypeError} when `id` or `name` is not usable
 */
export async function cancelCronJob({ restateURL, id, name = DEFAULT_CRON_JOB_NAME }) {
	checkJobId('cancelCronJob', id)
	checkName('cancelCronJob', name)
	await sendMessage({ restateURL, name, message: 'cancel', key: id })
	const left = await getCronJob({ restateURL, id, name })
	if (left) throw new Error(`Cron job '${id}' is still scheduled after it was cancelled`)
}

/** The state key of the default cron job object (a live binding: `setJobStateName` changes it). */
export { JOB_STATE_NAME }
