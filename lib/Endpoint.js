import http2 from 'node:http2'
import * as restate from '@restatedev/restate-sdk'

/**
 * An endpoint that only serves: the given services/workflows over HTTP/2 on `port`, and nothing else.
 * Unlike `setupRestate` it does not register with Restate and does not delete its deployment when it stops. Use it
 * when something else owns registration, for example a supervisor that registers the address once and restarts the
 * process: workflows already running on a deployment are pinned to its address and must be able to wait for it to
 * come back. It stops accepting connections on SIGINT/SIGTERM.
 *
 * @param {{port: number, services: Parameters<typeof restate.createEndpointHandler>[0]['services']}} params
 * @returns {Promise<import('node:http2').Http2Server>} resolves once it is listening
 */
export async function serveEndpoint({ port, services }) {
	const server = http2.createServer(restate.createEndpointHandler({ services }))
	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, resolve)
	})
	// Open sessions from Restate would keep close() waiting; in-flight calls are retried by Restate anyway.
	const stop = () => {
		server.close()
		setTimeout(() => process.exit(0), 1000)
	}
	process.once('SIGINT', stop)
	process.once('SIGTERM', stop)
	return server
}
