import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
	checkServiceHandler,
	startSubWorkflow,
	callSubWorkflow,
	listServices,
	deleteDeployment,
	service,
	listHandlers,
	submitWorkflow,
	submitWorkflowDiscovery,
	waitForInvocation,
	pollInvocation,
	sendMessage,
	sendMessageAsync,
	sendMessageWithDiscovery,
	sendMessageAsyncWithDiscovery,
	registerDeployment,
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

describe('deleteDeployment', () => {
	test('resolves on success', async () => {
		globalThis.fetch = mock(async () => jsonResponse({}))
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
})
