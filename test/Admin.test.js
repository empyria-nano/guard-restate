import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
	checkServiceHandler,
	startSubWorkflow,
	callSubWorkflow,
	childKey,
	CHILD_KEY_SEPARATOR,
	listServices,
	queryRestate,
	deleteDeployment,
	service,
	listHandlers,
	submitWorkflow,
	submitWorkflowDiscovery,
	waitForInvocation,
	pollInvocation,
	getInvocationOutput,
	sendMessage,
	sendMessageAsync,
	sendMessageWithDiscovery,
	sendMessageAsyncWithDiscovery,
	registerDeployment,
	shouldDeleteOnShutdown,
	parseServiceURL,
	sendMessageAsynSafe,
	defineWorkflow,
	defineService,
	defineObject,
	createRestateAdmin,
	restate,
	clients,
} from '../lib/Admin.js'

// Captured once, before anything ever mocks '@restatedev/restate-sdk-clients' — `clients`
// itself is a live binding, so reading `clients.connect` later could observe a still-active
// mock instead of the real function.
const realConnect = clients.connect

const jsonResponse = (body, ok = true, status = ok ? 200 : 500) => ({
	ok,
	status,
	statusText: ok ? 'OK' : 'Error',
	json: async () => body,
	text: async () => JSON.stringify(body),
})

let originalFetch

beforeEach(() => {
	originalFetch = globalThis.fetch
})

afterEach(() => {
	globalThis.fetch = originalFetch
})

const servicesPayload = {
	services: [
		{ name: 'MySvc', handlers: [{ name: 'run', ty: 'Workflow' }] },
		{ name: 'OtherSvc', handlers: [{ name: 'ping', ty: 'Shared' }] },
	],
}

// checkServiceHandler's cache (RESTATE_CACHE) is module-level state shared across every
// call in the process, with no way to reset it from outside — and a cache hit skips the
// expectedType check entirely. Each test below uses its own service name so they don't
// pollute each other's cache entries.
describe('checkServiceHandler', () => {
	test('resolves true when the service/handler exist', async () => {
		globalThis.fetch = mock(async () => jsonResponse(servicesPayload))
		expect(await checkServiceHandler('http://admin', 'MySvc', 'run')).toBe(true)
	})

	test('caches results — a second call for the same service does not re-fetch', async () => {
		// A fresh service name, in a payload of its own — every successful fetch replaces
		// the whole cache with that response's services, so reusing `servicesPayload` (or
		// any name it lists) here would already be cached by an earlier test.
		const fetchMock = mock(async () =>
			jsonResponse({ services: [{ name: 'CachedSvc', handlers: [{ name: 'ping' }] }] }),
		)
		globalThis.fetch = fetchMock
		await checkServiceHandler('http://admin', 'CachedSvc', 'ping')
		await checkServiceHandler('http://admin', 'CachedSvc', 'ping')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	test('throws when the service is not registered', async () => {
		globalThis.fetch = mock(async () => jsonResponse(servicesPayload))
		await expect(checkServiceHandler('http://admin', 'NopeSvc1', 'run')).rejects.toThrow(
			restate.TerminalError,
		)
	})

	test('throws when the handler is not found on the service', async () => {
		globalThis.fetch = mock(async () => jsonResponse(servicesPayload))
		await expect(checkServiceHandler('http://admin', 'MySvc', 'nope-handler')).rejects.toThrow(
			restate.TerminalError,
		)
	})

	test('throws when the handler type does not match', async () => {
		globalThis.fetch = mock(async () => ({
			ok: true,
			json: async () => ({
				services: [{ name: 'TypedSvc', handlers: [{ name: 'run', ty: 'Workflow' }] }],
			}),
		}))
		await expect(
			checkServiceHandler('http://admin', 'TypedSvc', 'run', 'Shared'),
		).rejects.toThrow(restate.TerminalError)
	})

	test('throws when the /services fetch fails', async () => {
		globalThis.fetch = mock(async () => jsonResponse(null, false))
		await expect(checkServiceHandler('http://admin', 'UnfetchableSvc', 'run')).rejects.toThrow(
			restate.TerminalError,
		)
	})
})

describe('childKey', () => {
	test('joins parent key and node path', () => {
		expect(childKey('order-42', 'approval')).toBe('order-42:approval')
		expect(CHILD_KEY_SEPARATOR).toBe(':')
	})

	test('appends the iteration when given, including 0', () => {
		expect(childKey('order-42', 'shipment', 3)).toBe('order-42:shipment:3')
		expect(childKey('order-42', 'shipment', 0)).toBe('order-42:shipment:0')
	})

	test('nests: a grandchild key extends the child key', () => {
		expect(childKey(childKey('order-42', 'approval'), 'review', 1)).toBe(
			'order-42:approval:review:1',
		)
	})

	test('rejects empty or separator-containing segments and an empty parent', () => {
		expect(() => childKey('order-42', '')).toThrow(TypeError)
		expect(() => childKey('order-42', 'a:b')).toThrow(TypeError)
		expect(() => childKey('order-42', 'a/b')).toThrow(TypeError)
		expect(() => childKey('order-42', 'step', '')).toThrow(TypeError)
		expect(() => childKey('', 'step')).toThrow(TypeError)
	})
})

describe('startSubWorkflow / callSubWorkflow', () => {
	test("startSubWorkflow sends via ctx.genericSend to the workflow's run handler", () => {
		let sentArgs
		const ctx = { genericSend: (args) => (sentArgs = args) ?? 'handle' }
		startSubWorkflow(ctx, 'MyWorkflow', 'wf-key-1', { a: 1 })
		expect(sentArgs.service).toBe('MyWorkflow')
		expect(sentArgs.method).toBe('run')
		expect(sentArgs.key).toBe('wf-key-1')
		expect(sentArgs.parameter).toEqual({ a: 1 })
	})

	test('callSubWorkflow calls via ctx.genericCall and returns its result', async () => {
		let calledArgs
		const ctx = {
			genericCall: async (args) => {
				calledArgs = args
				return { done: true }
			},
		}
		const result = await callSubWorkflow(ctx, 'MyWorkflow', 'wf-key-2', { b: 2 })
		expect(calledArgs.service).toBe('MyWorkflow')
		expect(calledArgs.key).toBe('wf-key-2')
		expect(result).toEqual({ done: true })
	})

	// Both functions only need `ctx.genericSend`/`ctx.genericCall`, which the SDK declares on
	// the base Context interface — every handler type has it, not just a workflow's own
	// context. Named explicitly (not just "a ctx mock", like the two tests above already are)
	// to document that calling these from a plain, unkeyed `restate.service` handler — e.g. to
	// idempotently start a long-running workflow the moment that service first learns the
	// workflow's key exists — is a supported, intended use, not an incidental side effect of
	// duck typing.
	test('startSubWorkflow works from a plain (non-workflow) service context', () => {
		let sentArgs
		/** @type {import('@restatedev/restate-sdk').Context} */
		const plainServiceCtx = { genericSend: (args) => (sentArgs = args) ?? 'handle' }
		startSubWorkflow(plainServiceCtx, 'DemoWorkflow', 'CA08841DVCA26', {
			triggeredBy: 'swift-upstream-sort',
		})
		expect(sentArgs.service).toBe('DemoWorkflow')
		expect(sentArgs.method).toBe('run')
		expect(sentArgs.key).toBe('CA08841DVCA26')
	})
})

describe('listServices', () => {
	test('returns the services array', async () => {
		globalThis.fetch = mock(async () => jsonResponse(servicesPayload))
		expect(await listServices({ restateAdminURL: 'http://admin' })).toEqual(
			servicesPayload.services,
		)
	})

	test('throws on a failed fetch', async () => {
		globalThis.fetch = mock(async () => jsonResponse(null, false))
		await expect(listServices({ restateAdminURL: 'http://admin' })).rejects.toThrow(
			restate.TerminalError,
		)
	})
})

describe('queryRestate', () => {
	test('POSTs {query: sql} to /query and returns the rows', async () => {
		const rows = [{ target_service_key: 'CA0001', status: 'suspended' }]
		globalThis.fetch = mock(async (url, init) => {
			expect(String(url)).toBe('http://admin/query')
			expect(JSON.parse(init.body)).toEqual({ query: 'SELECT 1' })
			return jsonResponse({ rows })
		})
		expect(await queryRestate({ restateAdminURL: 'http://admin', sql: 'SELECT 1' })).toEqual(
			rows,
		)
	})

	test('throws a TerminalError on a failed query', async () => {
		globalThis.fetch = mock(async () => jsonResponse(null, false))
		await expect(
			queryRestate({ restateAdminURL: 'http://admin', sql: 'SELECT 1' }),
		).rejects.toThrow(restate.TerminalError)
	})
})

describe('deleteDeployment', () => {
	test('resolves on success', async () => {
		globalThis.fetch = mock(async () => jsonResponse({}))
		await expect(deleteDeployment('http://admin', 'dep-1')).resolves.toBeUndefined()
	})

	test('treats an unknown deployment (404) as already deleted', async () => {
		globalThis.fetch = mock(async () => jsonResponse(null, false, 404))
		await expect(deleteDeployment('http://admin', 'dep-1')).resolves.toBeUndefined()
	})

	test('throws on failure', async () => {
		globalThis.fetch = mock(async () => jsonResponse(null, false))
		await expect(deleteDeployment('http://admin', 'dep-1')).rejects.toThrow(
			restate.TerminalError,
		)
	})
})

describe('service / listHandlers', () => {
	test('service returns the service metadata', async () => {
		globalThis.fetch = mock(async () => jsonResponse(servicesPayload.services[0]))
		expect(await service({ restateAdminURL: 'http://admin', name: 'MySvc' })).toEqual(
			servicesPayload.services[0],
		)
	})

	test('service throws a 404-specific error', async () => {
		globalThis.fetch = mock(async () => jsonResponse(null, false, 404))
		await expect(service({ restateAdminURL: 'http://admin', name: 'Nope' })).rejects.toThrow(
			restate.TerminalError,
		)
	})

	test('service throws a generic error for non-404 failures', async () => {
		globalThis.fetch = mock(async () => jsonResponse(null, false, 500))
		await expect(service({ restateAdminURL: 'http://admin', name: 'Nope' })).rejects.toThrow(
			restate.TerminalError,
		)
	})

	test('listHandlers delegates to service and returns its handlers', async () => {
		globalThis.fetch = mock(async () => jsonResponse(servicesPayload.services[0]))
		expect(await listHandlers({ restateAdminURL: 'http://admin', name: 'MySvc' })).toEqual(
			servicesPayload.services[0].handlers,
		)
	})
})

describe('submitWorkflow', () => {
	test('returns the submission on Accepted', async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ invocationId: 'inv-1', status: 'Accepted' }),
		)
		const result = await submitWorkflow({
			restateURL: 'http://ingress',
			name: 'Wf',
			payload: {},
		})
		expect(result).toEqual({ invocationId: 'inv-1', status: 'Accepted' })
	})

	test('throws on an unexpected status', async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ invocationId: 'inv-1', status: 'Weird' }),
		)
		await expect(
			submitWorkflow({ restateURL: 'http://ingress', name: 'Wf', payload: {} }),
		).rejects.toThrow()
	})

	test('throws when the request fails', async () => {
		globalThis.fetch = mock(async () => jsonResponse(null, false))
		await expect(
			submitWorkflow({ restateURL: 'http://ingress', name: 'Wf', payload: {} }),
		).rejects.toThrow()
	})
})

describe('submitWorkflowDiscovery', () => {
	test('validates the handler exists before submitting', async () => {
		globalThis.fetch = mock(async (url) => {
			if (String(url).endsWith('/services')) return jsonResponse(servicesPayload)
			return jsonResponse({ invocationId: 'inv-1', status: 'Accepted' })
		})
		const submit = submitWorkflowDiscovery({ restateAdminURL: 'http://admin' })
		const result = await submit({ restateURL: 'http://ingress', name: 'MySvc', payload: {} })
		expect(result.status).toBe('Accepted')
	})
})

describe('getInvocationOutput', () => {
	const look = (response) => {
		globalThis.fetch = mock(async () => response)
		return getInvocationOutput({ restateURL: 'http://ingress', invocationId: 'inv-1' })
	}

	test('done: returns the output', async () => {
		expect(await look(jsonResponse({ a: 1 }))).toEqual({ state: 'done', output: { a: 1 } })
	})

	test('running: 470 means no result yet', async () => {
		expect(await look(jsonResponse(null, false, 470))).toEqual({ state: 'running' })
	})

	test('failed: an error of the invocation itself', async () => {
		const body = { code: 404, message: 'no such skill', source: 'invocation' }
		expect(await look(jsonResponse(body, false, 404))).toEqual({
			state: 'failed',
			code: 404,
			message: 'no such skill',
		})
	})

	test('unknown: the ingress does not know the invocation', async () => {
		expect(await look(jsonResponse({ message: 'x', source: 'ingress' }, false, 400))).toEqual({
			state: 'unknown',
		})
	})

	test('anything else is an error', async () => {
		await expect(look(jsonResponse(null, false, 503))).rejects.toThrow('503')
	})
})

describe('waitForInvocation / pollInvocation', () => {
	test('waitForInvocation returns the attach result', async () => {
		globalThis.fetch = mock(async () => jsonResponse({ done: true }))
		expect(
			await waitForInvocation({ restateURL: 'http://ingress', invocationId: 'inv-1' }),
		).toEqual({ done: true })
	})

	test('waitForInvocation throws on failure', async () => {
		globalThis.fetch = mock(async () => jsonResponse(null, false))
		await expect(
			waitForInvocation({ restateURL: 'http://ingress', invocationId: 'inv-1' }),
		).rejects.toThrow()
	})

	test('pollInvocation retries on 470 then returns the output', async () => {
		let calls = 0
		globalThis.fetch = mock(async () => {
			calls++
			if (calls < 3) return { ok: false, status: 470 }
			return jsonResponse({ result: 42 })
		})
		const result = await pollInvocation({
			restateURL: 'http://ingress',
			invocationId: 'inv-1',
			intervalMs: 1,
		})
		expect(result).toEqual({ result: 42 })
		expect(calls).toBe(3)
	})

	test('pollInvocation throws on an unexpected status', async () => {
		globalThis.fetch = mock(async () => ({ ok: false, status: 500 }))
		await expect(
			pollInvocation({ restateURL: 'http://ingress', invocationId: 'inv-1', intervalMs: 1 }),
		).rejects.toThrow()
	})
})

describe('sendMessage / sendMessageAsync', () => {
	test('sendMessage returns the parsed JSON body', async () => {
		globalThis.fetch = mock(async () => ({ ok: true, text: async () => '{"a":1}' }))
		const result = await sendMessage({
			restateURL: 'http://ingress',
			name: 'Svc',
			message: 'do',
			payload: {},
		})
		expect(result).toEqual({ a: 1 })
	})

	test('sendMessage returns undefined for an empty response body', async () => {
		globalThis.fetch = mock(async () => ({ ok: true, text: async () => '' }))
		const result = await sendMessage({
			restateURL: 'http://ingress',
			name: 'Svc',
			message: 'do',
			payload: {},
		})
		expect(result).toBeUndefined()
	})

	test('sendMessage throws on failure', async () => {
		globalThis.fetch = mock(async () => ({ ok: false, status: 500, statusText: 'err' }))
		await expect(
			sendMessage({ restateURL: 'http://ingress', name: 'Svc', message: 'do', payload: {} }),
		).rejects.toThrow()
	})

	test('sendMessageAsync returns the submission on Accepted', async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ invocationId: 'inv-2', status: 'Accepted' }),
		)
		const result = await sendMessageAsync({
			restateURL: 'http://ingress',
			name: 'Svc',
			message: 'do',
			payload: {},
		})
		expect(result.invocationId).toBe('inv-2')
	})

	test('sendMessageAsync throws on failure', async () => {
		globalThis.fetch = mock(async () => ({ ok: false, status: 500, statusText: 'err' }))
		await expect(
			sendMessageAsync({
				restateURL: 'http://ingress',
				name: 'Svc',
				message: 'do',
				payload: {},
			}),
		).rejects.toThrow()
	})

	test('sendMessageAsync throws on an unexpected status', async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ invocationId: 'inv-2', status: 'Weird' }),
		)
		await expect(
			sendMessageAsync({
				restateURL: 'http://ingress',
				name: 'Svc',
				message: 'do',
				payload: {},
			}),
		).rejects.toThrow()
	})

	test('sends the idempotency-key header only when idempotencyKey is given', async () => {
		const seen = []
		globalThis.fetch = mock(async (url, init) => {
			seen.push(init.headers)
			return String(url).endsWith('/send')
				? jsonResponse({ invocationId: 'inv-3', status: 'PreviouslyAccepted' })
				: { ok: true, text: async () => '' }
		})
		const base = { restateURL: 'http://ingress', name: 'Svc', message: 'do', payload: {} }
		await sendMessage({ ...base, idempotencyKey: 'req-1' })
		await sendMessageAsync({ ...base, idempotencyKey: 'req-2' })
		await sendMessage(base)
		expect(seen[0]['idempotency-key']).toBe('req-1')
		expect(seen[1]['idempotency-key']).toBe('req-2')
		expect(seen[2]).not.toHaveProperty('idempotency-key')
	})

	test('sendMessageWithDiscovery / sendMessageAsyncWithDiscovery validate first', async () => {
		globalThis.fetch = mock(async (url) => {
			if (String(url).endsWith('/services')) return jsonResponse(servicesPayload)
			return { ok: true, text: async () => '' }
		})
		const send = sendMessageWithDiscovery({ restateAdminURL: 'http://admin' })
		await expect(
			send({ restateURL: 'http://ingress', name: 'MySvc', message: 'run', payload: {} }),
		).resolves.toBeUndefined()

		globalThis.fetch = mock(async (url) => {
			if (String(url).endsWith('/services')) return jsonResponse(servicesPayload)
			return jsonResponse({ invocationId: 'x', status: 'Accepted' })
		})
		const sendAsync = sendMessageAsyncWithDiscovery({ restateAdminURL: 'http://admin' })
		const result = await sendAsync({
			restateURL: 'http://ingress',
			name: 'MySvc',
			message: 'run',
			payload: {},
		})
		expect(result.status).toBe('Accepted')
	})
})

describe('registerDeployment', () => {
	test('returns the registration result on success', async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ id: 'dep-1', services: [{ name: 'X' }] }),
		)
		const result = await registerDeployment({
			restateAdminURL: 'http://admin',
			serviceURL: 'http://svc',
		})
		expect(result.id).toBe('dep-1')
	})

	test('throws with the response body on failure', async () => {
		globalThis.fetch = mock(async () => ({
			ok: false,
			status: 400,
			text: async () => 'bad uri',
		}))
		await expect(
			registerDeployment({ restateAdminURL: 'http://admin', serviceURL: 'http://svc' }),
		).rejects.toThrow(/bad uri/)
	})

	test('sends force: null by default and force: true when asked, to the deployments endpoint', async () => {
		const sent = []
		globalThis.fetch = mock(async (url, init) => {
			sent.push({ url, body: JSON.parse(init.body) })
			return jsonResponse({ id: 'dep-1', services: [] })
		})
		await registerDeployment({ restateAdminURL: 'http://admin', serviceURL: 'http://svc:9080' })
		await registerDeployment({
			restateAdminURL: 'http://admin',
			serviceURL: 'http://svc:9080',
			force: true,
		})
		expect(sent).toEqual([
			{ url: 'http://admin/deployments', body: { uri: 'http://svc:9080', force: null } },
			{ url: 'http://admin/deployments', body: { uri: 'http://svc:9080', force: true } },
		])
	})
})

describe('parseServiceURL', () => {
	test('returns the URL unchanged with the port it carries', () => {
		expect(parseServiceURL('http://agent-service:9080')).toEqual({
			serviceURL: 'http://agent-service:9080',
			port: 9080,
		})
		expect(parseServiceURL('https://svc.example.com:9443/base')).toEqual({
			serviceURL: 'https://svc.example.com:9443/base',
			port: 9443,
		})
	})

	test('requires a serviceURL', () => {
		expect(() => parseServiceURL(undefined)).toThrow(/needs `serviceURL`/)
		expect(() => parseServiceURL('')).toThrow(/needs `serviceURL`/)
	})

	test('rejects a URL without a scheme or with a non-http scheme', () => {
		expect(() => parseServiceURL('agent-service:9080')).toThrow(/http/)
		expect(() => parseServiceURL('not a url')).toThrow(/complete URL/)
		expect(() => parseServiceURL('ftp://svc:21')).toThrow(/http or https/)
	})

	test("uses the scheme's default port when the URL has none or states it", () => {
		expect(parseServiceURL('https://svc.example.com').port).toBe(443)
		expect(parseServiceURL('https://svc.example.com:443').port).toBe(443)
		expect(parseServiceURL('http://svc').port).toBe(80)
		expect(parseServiceURL('http://svc:80').port).toBe(80)
	})
})

describe('shouldDeleteOnShutdown', () => {
	test('deletes a registered deployment by default', () => {
		expect(shouldDeleteOnShutdown({ deploymentId: 'dep-1' })).toBe(true)
	})

	test('keeps it when asked, so invocations in flight can resume after a restart', () => {
		expect(
			shouldDeleteOnShutdown({ deploymentId: 'dep-1', keepDeploymentOnShutdown: true }),
		).toBe(false)
	})

	test('never deletes without a real deployment', () => {
		for (const deploymentId of [undefined, '']) {
			expect(shouldDeleteOnShutdown({ deploymentId })).toBe(false)
		}
	})
})

// `clients` is a live ESM namespace binding (read-only — Object.assign/property
// reassignment throws), so swapping its `connect` implementation needs mock.module
// against the underlying package rather than patching the imported namespace object.
describe('sendMessageAsynSafe', () => {
	afterEach(() => {
		mock.module('@restatedev/restate-sdk-clients', () => ({ ...clients, connect: realConnect }))
	})

	test('throws a TerminalError when the CallerService does not respond within the timeout', async () => {
		const fakeClient = { dispatch: () => new Promise(() => {}) } // never resolves
		mock.module('@restatedev/restate-sdk-clients', () => ({
			...clients,
			connect: () => ({ serviceClient: () => fakeClient }),
		}))

		await expect(
			sendMessageAsynSafe({
				restateURL: 'http://ingress',
				callerParams: { name: 'Svc', handler: 'do', payload: {} },
				timeout: 10,
			}),
		).rejects.toThrow(restate.TerminalError)
	})

	test('resolves with the invocation ID when the CallerService responds in time', async () => {
		const fakeClient = { dispatch: async () => 'inv-3' }
		mock.module('@restatedev/restate-sdk-clients', () => ({
			...clients,
			connect: () => ({ serviceClient: () => fakeClient }),
		}))

		const result = await sendMessageAsynSafe({
			restateURL: 'http://ingress',
			callerParams: { name: 'Svc', handler: 'do', payload: {} },
			timeout: 1000,
		})
		expect(result).toBe('inv-3')
	})
})

// setupRestate is intentionally not covered here: it binds real HTTP/2 + health-check
// ports, installs process-wide SIGTERM/SIGINT handlers, and its returned `forceClose`
// calls `process.exit()` — none of which are safe to exercise in-process in a test run.
// deleteDeployment/registerDeployment (which it composes) are covered above.

describe('defineWorkflow / defineService / defineObject', () => {
	test('are passthroughs to the underlying restate.* definers', () => {
		const wf = defineWorkflow({ name: 'Wf', handlers: { run: async () => {} } })
		expect(wf.name).toBe('Wf')

		const svc = defineService({ name: 'Svc', handlers: { do: async () => {} } })
		expect(svc.name).toBe('Svc')

		const obj = defineObject({ name: 'Obj', handlers: { do: async () => {} } })
		expect(obj.name).toBe('Obj')
	})
})

describe('createRestateAdmin', () => {
	test('binds restateAdminURL/restateURL across its methods', async () => {
		globalThis.fetch = mock(async (url) => {
			expect(String(url)).toContain('http://admin')
			return jsonResponse(servicesPayload)
		})
		const admin = createRestateAdmin({
			restateAdminURL: 'http://admin',
			restateURL: 'http://ingress',
		})
		expect(await admin.listServices()).toEqual(servicesPayload.services)
	})

	test('query() binds restateAdminURL and forwards the raw SQL', async () => {
		const rows = [{ status: 'completed' }]
		globalThis.fetch = mock(async (url, init) => {
			expect(String(url)).toBe('http://admin/query')
			expect(JSON.parse(init.body)).toEqual({ query: 'SELECT status FROM sys_invocation' })
			return jsonResponse({ rows })
		})
		const admin = createRestateAdmin({
			restateAdminURL: 'http://admin',
			restateURL: 'http://ingress',
		})
		expect(await admin.query('SELECT status FROM sys_invocation')).toEqual(rows)
	})
	test('sendMessage/sendMessageAsync forward idempotencyKey', async () => {
		const seen = []
		globalThis.fetch = mock(async (url, init) => {
			seen.push(init.headers['idempotency-key'])
			return jsonResponse({ invocationId: 'inv-4', status: 'Accepted' })
		})
		const admin = createRestateAdmin({
			restateAdminURL: 'http://admin',
			restateURL: 'http://ingress',
		})
		const msg = { name: 'Svc', message: 'do', payload: {} }
		await admin.sendMessage({ ...msg, idempotencyKey: 'a' })
		await admin.sendMessageAsync({ ...msg, idempotencyKey: 'b' })
		expect(seen).toEqual(['a', 'b'])
	})
})
