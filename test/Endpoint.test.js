import { describe, expect, test } from 'bun:test'
import http2 from 'node:http2'
import * as restate from '@restatedev/restate-sdk'
import { serveEndpoint } from '../lib/Endpoint.js'

describe('serveEndpoint', () => {
	test('listens over HTTP/2 and answers Restate discovery, without registering anywhere', async () => {
		const hello = restate.service({ name: 'Hello', handlers: { hi: async () => 'hi' } })
		const server = await serveEndpoint({ port: 0, services: [hello] })
		const { port } = server.address()
		const client = http2.connect(`http://127.0.0.1:${port}`)
		const body = await new Promise((resolve, reject) => {
			const req = client.request({
				':path': '/discover',
				accept: 'application/vnd.restate.endpointmanifest.v3+json',
			})
			let text = ''
			req.on('data', (chunk) => (text += chunk))
			req.on('end', () => resolve(text))
			req.on('error', reject)
			req.end()
		})
		client.close()
		server.close()
		expect(JSON.parse(body).services.map((s) => s.name)).toEqual(['Hello'])
	})

	test('fails when the port is taken', async () => {
		const first = await serveEndpoint({ port: 0, services: [] })
		const { port } = first.address()
		await expect(serveEndpoint({ port, services: [] })).rejects.toThrow()
		first.close()
	})
})
