/**
 * @typedef {Object} CallerParams
 * @property {string} name - Target service name as registered in Restate.
 * @property {string} handler - Handler name to invoke on the target service.
 * @property {object} payload - JSON payload forwarded to the handler.
 */

/**
 * CallerServiceDef — a generic Restate service that dispatches a fire-and-
 * forget call to any handler on any other service by name.
 *
 * Why does this exist?
 * Inside a Restate workflow or virtual object you cannot call another service
 * handler dynamically by string name using the typed SDK clients — the client
 * is bound to a specific service definition at compile time. CallerService
 * breaks that constraint: a workflow sends a {@link CallerParams} message to
 * this service, which then uses `ctx.serviceSendClient` to fan the call out
 * to the target, and returns the resulting invocation ID.
 *
 * The retry policy is intentionally set to 1 attempt. The caller is
 * responsible for deciding whether to retry; this service is a thin proxy.
 */
export const CallerServiceDef = {
	name: 'CallerService',
	handlers: {
		/**
		 * @param {import('@restatedev/restate-sdk').Context} ctx
		 * @param {CallerParams} params
		 * @returns {Promise<string>} The invocation ID of the dispatched call.
		 * @throws {Error} If `handler` isn't a function on the target service's client.
		 */
		dispatch: async (ctx, { name, payload, handler }) => {
			const client = ctx.serviceSendClient({ name })

			const candidate = client[handler]
			if (typeof candidate !== 'function') {
				throw new Error(`Handler "${handler}" is not a function on service "${name}"`)
			}

			const { invocationId } = await candidate(payload)

			return await invocationId
		},
	},
	options: {
		retryPolicy: {
			maxAttempts: 1,
		},
	},
}
