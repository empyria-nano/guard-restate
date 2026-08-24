import { createPubsubObject, createPubsubPublisher } from '@restatedev/pubsub'
import { createPubsubClient } from '@restatedev/pubsub-client'

/**
 * Typed wrapper around `@restatedev/pubsub`'s `createPubsubObject`; see `Admin.js`'s
 * `defineWorkflow`/`defineService`/`defineObject` for the same "typed wrapper, plain passthrough
 * in JS" pattern this follows. Unlike those three, there's no handler map to write —
 * `createPubsubObject` returns a complete `VirtualObjectDefinition` on its own (pull/publish/
 * subscribe/truncate), so this exists purely for the same "one `define*` per Restate construct"
 * naming consistency, not to add behavior.
 *
 * Register the result alongside your other services/objects on the same endpoint (see
 * `setupRestate`'s `services` param — Admin.js) — that registration is what lets Restate route to
 * it at all. Restate's own ingress does NOT serve a ready-made SSE route for it, though: reaching
 * it from a browser needs an app-owned relay built on {@link pubsubClient}'s own `.sse()` (or a
 * hand-rolled loop over `.pull()`, e.g. to log each message before forwarding it) — confirmed
 * directly against `@restatedev/pubsub-client`'s compiled source, 2026-08-24, after an earlier,
 * wrong assumption that this was automatic.
 * @param {Parameters<typeof createPubsubObject>[0]} name
 * @param {Parameters<typeof createPubsubObject>[1]} [options]
 */
export function definePubsub(name, options) {
	return createPubsubObject(name, options)
}

/**
 * Typed wrapper around `@restatedev/pubsub`'s `createPubsubPublisher` — the in-process publish
 * path. Call the returned function from inside any handler that already has `ctx` and shares a
 * Restate endpoint with the pubsub object it targets (both registered via the same `services`
 * list passed to `setupRestate` — see {@link definePubsub}). Under the hood it's
 * `ctx.objectSendClient({name}, topic).publish(message)` — a real Restate call, already covered
 * by the invocation's own journal, so callers don't need to wrap it in an extra `ctx.run()`
 * themselves (unlike a plain `fetch()`-based call, e.g. `sendMessageAsync` in Admin.js, which
 * does).
 * @param {Parameters<typeof createPubsubPublisher>[0]} name
 */
export function pubsubPublisher(name) {
	return createPubsubPublisher(name)
}

/**
 * Typed wrapper around `@restatedev/pubsub-client`'s `createPubsubClient` — the out-of-process
 * counterpart to {@link pubsubPublisher}/{@link definePubsub}: a network client (`pull`/`sse`/
 * `publish`/`truncate`) for anything that ISN'T a handler on the same Restate endpoint as the
 * pubsub object — a separate process relaying to a browser, an external consumer, ... — reaching
 * it over a plain ingress URL instead of `ctx.objectSendClient`.
 * @param {Parameters<typeof createPubsubClient>[0]} pubsubOptions
 */
export function pubsubClient(pubsubOptions) {
	return createPubsubClient(pubsubOptions)
}
