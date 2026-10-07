import { describe, test, expect } from 'bun:test'
import { definePubsub, pubsubPublisher, pubsubClient } from '../lib/Pubsub.js'

describe('definePubsub', () => {
	test('is a passthrough to createPubsubObject, name and all', () => {
		const pubsub = definePubsub('pubsub')
		expect(pubsub.name).toBe('pubsub')
	})

	test('forwards options (e.g. pullTimeout) to createPubsubObject', () => {
		const pubsub = definePubsub('pubsub', { pullTimeout: { seconds: 30 } })
		expect(pubsub.name).toBe('pubsub')
	})
})

describe('pubsubPublisher', () => {
	test('returns a function that publishes via ctx.objectSendClient', () => {
		let capturedTarget
		let capturedKey
		let capturedMessage
		const fakeCtx = {
			objectSendClient: (target, key) => {
				capturedTarget = target
				capturedKey = key
				return {
					publish: (message) => {
						capturedMessage = message
					},
				}
			},
		}

		const publish = pubsubPublisher('pubsub')
		publish(fakeCtx, 'agent-service', { event: 'ask-triggered' })

		expect(capturedTarget).toEqual({ name: 'pubsub' })
		expect(capturedKey).toBe('agent-service')
		expect(capturedMessage).toEqual({ event: 'ask-triggered' })
	})
})

describe('pubsubClient', () => {
	test('is a passthrough to createPubsubClient exposing pull/sse/publish/truncate', () => {
		const client = pubsubClient({ url: 'http://localhost:8080', name: 'pubsub' })

		expect(typeof client.pull).toBe('function')
		expect(typeof client.sse).toBe('function')
		expect(typeof client.publish).toBe('function')
		expect(typeof client.truncate).toBe('function')
	})
})
