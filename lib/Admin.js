import { randomUUID } from 'node:crypto'
import http2 from 'node:http2'
import { createServer as createHttpServer } from 'http'

import { setTimeout as sleep } from 'timers/promises'

import * as restate from '@restatedev/restate-sdk'
import * as clients from '@restatedev/restate-sdk-clients'

export { restate, clients }

import { CallerServiceDef } from './Caller.js'

/**
 * A subset of the OpenAPI-generated `Components['schemas']` shapes (see
 * `../admin.types.ts`, regenerated via `../generateTypes.sh`) covering just the
 * fields this module actually reads. Not consumed at runtime — for editor hover only.
 * @typedef {Object} HandlerMetadata
 * @property {string} name
 * @property {'Exclusive'|'Shared'|'Workflow'} [ty]
 * @typedef {Object} ServiceMetadata
 * @property {string} name
 * @property {HandlerMetadata[]} handlers
 * @property {string} [ty]
 * @property {string} [deployment_id]
 * @typedef {Object} ServicesResponse
 * @property {ServiceMetadata[]} services
 * @typedef {Object} RegisterDeploymentRequest
 * @property {string} uri
 * @property {boolean|null} force
 * @typedef {Object} RegisterDeploymentResponse
 * @property {string} id
 * @property {{name: string}[]} services
 */

export const OK = 'OK'

/** @type {Record<string, string[]>} */
let RESTATE_CACHE = {}

/**
 * Error codes
 */
export const ERROR_VALIDATION = 52000
export const ERROR_INVOCATION = 52001
export const ERROR_INFRASTRUCTURE = 52002
export const ERROR_ARCHITECTURE = 52003

/**
 * Cap of retrying strategy's delay
 */
export const DELAY_CAP = 30_000

/**
 * Check if service and handler exist in Restate
 * @param {string} restateAdminURL
 * @param {string} serviceName
 * @param {string} handlerName
 * @param {'Exclusive'|'Shared'|'Workflow'} [expectedType]
 * @returns {Promise<boolean>}
 * @throws {RestateError} If service or handler not found
 */
export async function checkServiceHandler(restateAdminURL, serviceName, handlerName, expectedType) {
	if (RESTATE_CACHE?.[serviceName]?.includes(handlerName)) return true

	const response = await fetch(`${restateAdminURL}/services`)

	if (!response.ok) {
		throw new restate.TerminalError(
			`Failed to fetch services: ${response.status} ${response.statusText}`,
			{ errorCode: ERROR_INFRASTRUCTURE },
		)
	}

	/** @type {ServicesResponse} */
	const data = await response.json()

	/** @type {Record<string, string[]>} */
	const _RESTATE_CACHE = {}
	for (const _service of data.services) {
		_RESTATE_CACHE[_service.name] = _service.handlers.map((h) => h.name)
	}
	RESTATE_CACHE = _RESTATE_CACHE

	const service = data.services.find((s) => s.name === serviceName)

	if (!service) {
		throw new restate.TerminalError(`Service '${serviceName}' not registered in Restate`, {
			errorCode: ERROR_ARCHITECTURE,
		})
	}

	const handler = service.handlers.find((h) => h.name === handlerName)

	if (!handler) {
		throw new restate.TerminalError(
			`Handler '${handlerName}' not found in service '${serviceName}'`,
			{ errorCode: ERROR_ARCHITECTURE },
		)
	}

	if (expectedType && handler.ty !== expectedType) {
		throw new restate.TerminalError(
			`Handler '${handlerName}' is '${handler.ty}', expected '${expectedType}'`,
			{ errorCode: ERROR_ARCHITECTURE },
		)
	}

	return true
}

/**
 * List all registered services
 * @param {{restateAdminURL: string}} params
 * @returns {Promise<ServiceMetadata[]>}
 */
export async function listServices({ restateAdminURL }) {
	const response = await fetch(`${restateAdminURL}/services`)
	if (!response.ok) {
		throw new restate.TerminalError(
			`Failed to fetch services: ${response.status} ${response.statusText}`,
			{ errorCode: ERROR_INFRASTRUCTURE },
		)
	}
	/** @type {ServicesResponse} */
	const data = await response.json()
	return data.services // Array of { name, handlers, ty, deployment_id, ... }
}

/**
 * Force-deletes a deployment from Restate, draining any in-flight invocations.
 * @param {string} restateAdminURL
 * @param {string} deploymentId
 * @returns {Promise<void>}
 */
export async function deleteDeployment(restateAdminURL, deploymentId) {
	const response = await fetch(`${restateAdminURL}/deployments/${deploymentId}?force=true`, {
		method: 'DELETE',
	})
	if (!response.ok) {
		throw new restate.TerminalError(
			`Failed to delete deployment: ${response.status} ${response.statusText}`,
			{ errorCode: ERROR_INFRASTRUCTURE },
		)
	}
}

/**
 * Get a specific service's details including its handlers
 * @param {{restateAdminURL: string, name: string}} params
 * @returns {Promise<ServiceMetadata>}
 */
export async function service({ restateAdminURL, name }) {
	const response = await fetch(`${restateAdminURL}/services/${name}`)
	if (!response.ok) {
		if (response.status === 404) {
			throw new restate.TerminalError(`Service '${name}' not found`, {
				errorCode: ERROR_ARCHITECTURE,
			})
		}
		throw new restate.TerminalError(
			`Failed to fetch service: ${response.status} ${response.statusText}`,
			{ errorCode: ERROR_INFRASTRUCTURE },
		)
	}
	return await response.json()
}

/**
 * List handlers for a given service
 * @param {{restateAdminURL: string, name: string}} params
 * @returns {Promise<HandlerMetadata[]>}
 */
export async function listHandlers({ restateAdminURL, name }) {
	const _service = await service({ restateAdminURL, name })
	return _service.handlers
}

/**
 * @typedef {Object} BaseMessage Common fields shared by all Restate message types.
 * @property {string} restateURL
 * @property {string} name
 * @property {object} payload
 * @typedef {BaseMessage & {key: string}} WorkflowMessage Message targeting a Restate
 *   workflow — `key` is required to address the workflow instance.
 * @typedef {BaseMessage & {key?: string, message: string}} ServiceMessage Message
 *   targeting a Restate service or virtual object handler. `key` is the Virtual
 *   Object key (omit for plain services); `message` is the handler name.
 * @typedef {Object} InvocationSubmission Response returned by Restate when an
 *   invocation is enqueued asynchronously.
 * @property {string} invocationId
 * @property {'Accepted'|'PreviouslyAccepted'} status
 */

/**
 * Starts a sub-workflow and returns a handle to the invocation.
 * @template P
 * @param {import('@restatedev/restate-sdk').WorkflowContext} ctx Existing workflow context
 * @param {string} workflowName name of the workflow to start
 * @param {string} workflowKey key of the workflow instance to start
 * @param {P} payload payload to pass to the workflow
 * @returns {import('@restatedev/restate-sdk').InvocationHandle} handle to the invocation
 */
export function startSubWorkflow(ctx, workflowName, workflowKey, payload) {
	return ctx.genericSend({
		service: workflowName,
		method: 'run',
		key: workflowKey,
		parameter: payload,
		inputSerde: restate.serde.json,
	})
}

/**
 * Executes a sub-workflow and returns a promise resolving to the result.
 * @template P
 * @template [R=unknown]
 * @param {import('@restatedev/restate-sdk').WorkflowContext} ctx Existing workflow context
 * @param {string} workflowName name of the workflow to execute
 * @param {string} workflowKey key of the workflow instance to execute
 * @param {P} payload payload to pass to the workflow
 * @returns {Promise<R>} promise resolving to the result
 */
export function callSubWorkflow(ctx, workflowName, workflowKey, payload) {
	return ctx.genericCall({
		service: workflowName,
		method: 'run',
		key: workflowKey,
		parameter: payload,
		inputSerde: restate.serde.json,
		outputSerde: restate.serde.json,
	})
}

/**
 * Submits a Restate workflow with configurable retry policy.
 * @template TPayload
 * @param {Object} options
 * @param {string} options.restateURL - Restate endpoint URL
 * @param {string} options.name - Workflow name
 * @param {string} [options.key] - Unique workflow instance key
 * @param {TPayload} options.payload - Request payload
 * @returns {Promise<InvocationSubmission>}
 */
export async function submitWorkflow({ restateURL, name, key, payload }) {
	const workflowKey = key ?? randomUUID()

	const response = await fetch(`${restateURL}/${name}/${workflowKey}/run/send`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	})

	if (!response.ok) {
		throw new Error(
			`Failed to submit workflow '${name}/${workflowKey}': ${response.status} ${response.statusText}`,
		)
	}

	/** @type {InvocationSubmission} */
	const submission = await response.json()

	if (submission.status !== 'Accepted' && submission.status !== 'PreviouslyAccepted') {
		throw new Error(
			`Unexpected workflow submission status '${submission.status}' for '${name}/${workflowKey}'`,
		)
	}

	return submission
}

/**
 * Returns a submit function that validates the workflow's `run` handler exists
 * in Restate before forwarding to {@link submitWorkflow}.
 * @param {{restateAdminURL: string}} params
 * @returns {(message: WorkflowMessage) => Promise<InvocationSubmission>}
 */
export function submitWorkflowDiscovery({ restateAdminURL }) {
	return async ({ restateURL, name, key, payload }) => {
		await checkServiceHandler(restateAdminURL, name, 'run')

		return submitWorkflow({ restateURL, name, key, payload })
	}
}

/**
 * Long-polls the `/attach` endpoint until the invocation completes and returns its result.
 * @template TResult
 * @param {{restateURL: string, invocationId: string}} params
 * @returns {Promise<TResult>}
 */
export async function waitForInvocation({ restateURL, invocationId }) {
	const response = await fetch(`${restateURL}/restate/invocation/${invocationId}/attach`)

	if (!response.ok) {
		throw new Error(
			`Failed to attach to invocation '${invocationId}': ${response.status} ${response.statusText}`,
		)
	}

	return await response.json()
}

/**
 * Polls the `/output` endpoint at `intervalMs` intervals until output is
 * available (HTTP 470 means not yet ready).
 * @template TResult
 * @param {{restateURL: string, invocationId: string, intervalMs?: number}} params
 * @returns {Promise<TResult>}
 */
export async function pollInvocation({ restateURL, invocationId, intervalMs = 250 }) {
	while (true) {
		const response = await fetch(`${restateURL}/restate/invocation/${invocationId}/output`)

		if (response.ok) return await response.json()

		if (response.status !== 470) {
			throw new Error(
				`Unexpected status ${response.status} polling invocation '${invocationId}'`,
			)
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}
}

/**
 * Sends a message to a Restate service with configurable retry policy.
 * @template TResult
 * @param {ServiceMessage} params
 * @returns {Promise<TResult>}
 */
export async function sendMessage({ restateURL, name, message, key, payload }) {
	const path = key ? `${name}/${key}/${message}` : `${name}/${message}`
	const response = await fetch(`${restateURL}/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	})

	if (!response.ok) {
		throw new Error(
			`Failed to send '${name}/${message}': ${response.status} ${response.statusText}`,
		)
	}

	const text = await response.text()
	return text ? JSON.parse(text) : undefined
}

/**
 * Fire-and-forget variant of {@link sendMessage} — returns the invocation ID without waiting for a result.
 * @param {ServiceMessage} params
 * @returns {Promise<InvocationSubmission>}
 */
export async function sendMessageAsync({ restateURL, name, message, key, payload }) {
	const path = key ? `${name}/${key}/${message}` : `${name}/${message}`
	const response = await fetch(`${restateURL}/${path}/send`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	})

	if (!response.ok) {
		throw new Error(
			`Failed to send '${name}/${message}': ${response.status} ${response.statusText}`,
		)
	}

	/** @type {InvocationSubmission} */
	const submission = await response.json()

	if (submission.status !== 'Accepted' && submission.status !== 'PreviouslyAccepted') {
		throw new Error(
			`Unexpected submission status '${submission.status}' for '${name}/${message}'`,
		)
	}

	return submission
}

/**
 * Returns a send function that validates the service handler exists in Restate
 * before calling {@link sendMessage} synchronously.
 * @template TResult
 * @param {{restateAdminURL: string}} params
 * @returns {(message: ServiceMessage) => Promise<TResult>}
 */
export function sendMessageWithDiscovery({ restateAdminURL }) {
	return async ({ restateURL, name, message, key, payload }) => {
		await checkServiceHandler(restateAdminURL, name, message)

		return sendMessage({ restateURL, name, message, key, payload })
	}
}

/**
 * Returns a fire-and-forget send function that validates the service handler
 * exists in Restate before calling {@link sendMessageAsync}.
 * @param {{restateAdminURL: string}} params
 * @returns {(message: ServiceMessage) => Promise<InvocationSubmission>}
 */
export function sendMessageAsyncWithDiscovery({ restateAdminURL }) {
	return async ({ restateURL, name, message, key, payload }) => {
		await checkServiceHandler(restateAdminURL, name, message)

		return sendMessageAsync({ restateURL, name, message, key, payload })
	}
}

/**
 * @typedef {import('node:http2').Http2Server & {deploymentId: string, services: string[], forceClose: () => void}} RestateServer
 */

/**
 * Typed wrapper around `restate.workflow` that preserves handler map inference in
 * TypeScript consumers; in plain JS this is a passthrough kept for API-surface parity.
 * @param {Parameters<typeof restate.workflow>[0]} def
 */
export function defineWorkflow(def) {
	return restate.workflow(def)
}

/**
 * Typed wrapper around `restate.service`; see {@link defineWorkflow}.
 * @param {Parameters<typeof restate.service>[0]} def
 */
export function defineService(def) {
	return restate.service(def)
}

/**
 * Typed wrapper around `restate.object`; see {@link defineWorkflow}.
 * @param {Parameters<typeof restate.object>[0]} def
 */
export function defineObject(def) {
	return restate.object(def)
}

/**
 * Starts the HTTP/2 Restate endpoint, a health-check HTTP server, registers
 * the deployment with the admin API, and wires SIGTERM/SIGINT for graceful
 * shutdown (deregistering the deployment before exiting).
 * @param {Object} params
 * @param {string} params.restateAdminURL
 * @param {string} params.host
 * @param {number} params.port
 * @param {number} [params.healthPort] - Defaults to `port + 1`.
 * @param {Parameters<typeof restate.createEndpointHandler>[0]['services']} [params.services]
 * @param {() => void} [params.shutdownCallbackFn]
 * @param {(deploymentId: string) => void} [params.registrationCallbackFn]
 * @returns {Promise<RestateServer>}
 */
export async function setupRestate({
	restateAdminURL,
	host,
	port,
	healthPort = port + 1,
	services = [],
	shutdownCallbackFn,
	registrationCallbackFn,
}) {
	const handler = restate.createEndpointHandler({ services })

	const server = http2.createServer(handler)

	// --- Health server ---
	let isHealthy = false

	const healthServer = createHttpServer((req, res) => {
		if (
			(req.url === '/health' ||
				req.url === '/health/liveness' ||
				req.url === '/health/readiness') &&
			req.method === 'GET'
		) {
			const status = isHealthy ? 200 : 503
			const body = JSON.stringify({
				status: isHealthy ? 'ok' : 'unavailable',
				deployment: server.deploymentId,
				services: server.services,
			})
			res.writeHead(status, { 'Content-Type': 'application/json' })
			res.end(body)
		} else {
			res.writeHead(404)
			res.end()
		}
	})

	healthServer.listen(healthPort, () => console.log(`Health endpoint on :${healthPort}/health`))

	const sessions = new Set()
	server.on('session', (session) => {
		sessions.add(session)
		session.on('close', () => sessions.delete(session))
	})

	const forceClose = async () => shutdown('SIGTERM')

	const shutdown = async (signal) => {
		const deploymentId = server.deploymentId

		console.log(`${signal} received, shutting down... Deployment: ${deploymentId}`)

		isHealthy = false

		try {
			if (deploymentId && deploymentId !== 'NA') {
				await deleteDeployment(restateAdminURL, deploymentId)
			}
		} catch (err) {
			console.error(err)
		} finally {
			shutdownCallbackFn?.()
			server.close()
			process.exit()
		}
	}
	const gracefulShutdown = (signal) => {
		shutdown(signal).catch(console.error)
	}

	process.on('SIGTERM', gracefulShutdown)
	process.on('SIGINT', gracefulShutdown)

	server.listen(port, () => console.log(`Server running on ${port}`))

	if (host && port) {
		const serviceURL = `http://${host}:${port}`

		/**
		 * @param {Object} params
		 * @param {string} params.restateAdminURL
		 * @param {string} params.serviceURL
		 * @param {number} [params.attempts=5]
		 * @param {number} [params.baseDelayMs=3000]
		 * @returns {Promise<RegisterDeploymentResponse>}
		 */
		async function registerDeploymentWithRetry({
			restateAdminURL,
			serviceURL,
			attempts = 5,
			baseDelayMs = 3_000,
		}) {
			let lastErr

			for (let attempt = 1; attempt <= attempts; attempt++) {
				try {
					const result = await registerDeployment({ restateAdminURL, serviceURL })

					try {
						registrationCallbackFn?.(result.id)
					} catch (err) {
						console.error(
							`Error in registration callback for deployment ${result.id}: ${
								err instanceof Error ? err.message : String(err)
							}`,
						)
					}

					return result
				} catch (err) {
					lastErr = err

					// Deterministic — retrying won't help. Bail immediately.
					if (err instanceof Error && err.message.includes('META0004')) {
						throw err
					}

					if (attempt < attempts) {
						const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), DELAY_CAP)
						console.log(
							`Registration attempt ${attempt}/${attempts} failed, retrying in ${delay}ms: ${
								err instanceof Error ? err.message : String(err)
							}`,
						)
						await sleep(delay)
					}
				}
			}

			throw new Error(
				`Failed to register deployment after ${attempts} attempts: ${
					lastErr instanceof Error ? lastErr.message : String(lastErr)
				}`,
			)
		}
		const deployment = await registerDeploymentWithRetry({
			restateAdminURL,
			serviceURL,
		}).catch(console.error)

		isHealthy = !!deployment // Only healthy once registered

		return Object.assign(server, {
			deploymentId: deployment?.id,
			services: deployment?.services?.map((s) => s.name),
			forceClose,
		})
	} else {
		isHealthy = true
	}

	return Object.assign(server, {
		deploymentId: 'NA',
		services: [],
		forceClose,
	})
}

/**
 * POSTs this process's HTTP endpoint to the Restate admin API so its services are discoverable.
 * @param {{restateAdminURL: string, serviceURL: string}} params
 * @returns {Promise<RegisterDeploymentResponse>}
 */
export async function registerDeployment({ restateAdminURL, serviceURL }) {
	const uri = serviceURL

	/** @type {RegisterDeploymentRequest} */
	const body = { uri, force: null }

	console.log(`Registering: ${uri} at: ${restateAdminURL}/deployments`)

	const response = await fetch(`${restateAdminURL}/deployments`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

	if (response.ok) {
		console.log(`✅ Deployment registered for ${uri}`)
		/** @type {RegisterDeploymentResponse} */
		const result = await response.json()
		console.log(
			'Discovered services:',
			result.services?.map((s) => s.name),
		)
		console.log(`Deployment details: ${JSON.stringify(result, null, 2)}`)
		return result
	}

	const text = await response.text()
	console.log(`Restate response details: ${text}`)
	throw new Error(`⚠️ Failed to register uri ${uri} (HTTP ${response.status}): ${text}`)
}

/**
 * @typedef {Object} SendMessageAsynSafeParams Parameters for {@link sendMessageAsynSafe}.
 * @property {string} restateURL
 * @property {import('./Caller.js').CallerParams} callerParams
 * @property {number} [timeout] Milliseconds to wait for the CallerService to respond
 *   before throwing. Defaults to 1000.
 */

/**
 * Dispatches a call via {@link CallerServiceDef} with a timeout guard.
 * Throws a `TerminalError` if the CallerService does not respond within
 * `timeout` ms (default 1000).
 * @param {SendMessageAsynSafeParams} params
 * @returns {Promise<string>}
 */
export const sendMessageAsynSafe = async ({ restateURL, callerParams, timeout }) => {
	const rs = clients.connect({ url: restateURL })
	const client = rs.serviceClient({ name: CallerServiceDef.name })

	const invocationId = await Promise.any([client.dispatch(callerParams), sleep(timeout ?? 1000)])

	if (invocationId) {
		return invocationId
	}

	throw new restate.TerminalError(
		`Failed to reach services: ${callerParams.name} ${callerParams.handler}`,
		{ errorCode: ERROR_INFRASTRUCTURE },
	)
}

/**
 * @typedef {Object} RestateAdmin
 * @property {() => Promise<ServiceMetadata[]>} listServices
 * @property {(params: {name: string}) => Promise<ServiceMetadata>} service
 * @property {(params: {name: string}) => Promise<HandlerMetadata[]>} listHandlers
 * @property {(params: Omit<Parameters<typeof setupRestate>[0], 'restateAdminURL'>) => Promise<RestateServer>} setupRestate
 * @property {(params: {serviceURL: string}) => Promise<RegisterDeploymentResponse>} registerDeployment
 * @property {(params: {name: string, key?: string, payload: *}) => Promise<InvocationSubmission>} submitWorkflow
 * @property {() => (message: WorkflowMessage) => Promise<InvocationSubmission>} submitWorkflowDiscovery
 * @property {(params: {invocationId: string}) => Promise<*>} waitForInvocation
 * @property {(params: {invocationId: string, intervalMs?: number}) => Promise<*>} pollInvocation
 * @property {(params: Omit<ServiceMessage, 'restateURL'>) => Promise<*>} sendMessage
 * @property {(params: Omit<ServiceMessage, 'restateURL'>) => Promise<InvocationSubmission>} sendMessageAsync
 * @property {() => (message: ServiceMessage) => Promise<*>} sendMessageWithDiscovery
 * @property {() => (message: ServiceMessage) => Promise<InvocationSubmission>} sendMessageAsyncWithDiscovery
 */

/**
 * Creates a {@link RestateAdmin} facade that binds `restateAdminURL` and
 * `restateURL` once so callers don't pass them on every operation.
 * @param {{restateAdminURL: string, restateURL: string}} params
 * @returns {RestateAdmin}
 */
export function createRestateAdmin({ restateAdminURL, restateURL }) {
	return {
		// Services
		listServices: () => listServices({ restateAdminURL }),
		service: ({ name }) => service({ restateAdminURL, name }),
		listHandlers: ({ name }) => listHandlers({ restateAdminURL, name }),

		// Management queries
		setupRestate: ({ port, healthPort, host, services, shutdownCallbackFn }) =>
			setupRestate({
				restateAdminURL,
				host,
				port,
				healthPort: healthPort ?? port + 1,
				services,
				shutdownCallbackFn,
			}),
		registerDeployment: ({ serviceURL }) => registerDeployment({ restateAdminURL, serviceURL }),

		submitWorkflow: ({ name, key, payload }) =>
			submitWorkflow({ restateURL, name, key, payload }),
		submitWorkflowDiscovery: () => submitWorkflowDiscovery({ restateAdminURL }),

		waitForInvocation: ({ invocationId }) => waitForInvocation({ restateURL, invocationId }),

		pollInvocation: ({ invocationId, intervalMs }) =>
			pollInvocation({ restateURL, invocationId, intervalMs }),

		sendMessage: ({ name, message, key, payload }) =>
			sendMessage({ restateURL, name, message, key, payload }),
		sendMessageAsync: ({ name, message, key, payload }) =>
			sendMessageAsync({ restateURL, name, message, key, payload }),
		sendMessageWithDiscovery: () => sendMessageWithDiscovery({ restateAdminURL }),
		sendMessageAsyncWithDiscovery: () => sendMessageAsyncWithDiscovery({ restateAdminURL }),
	}
}
