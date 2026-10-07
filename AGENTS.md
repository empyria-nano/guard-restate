# AGENTS.md

Restate.dev helpers for **Empyria**, a nanoservice framework built primarily on Bun:
an Admin API client, a dynamic-dispatch service, cron-driven workflow scheduling, and
schema validation for workflow handlers.

Targets Restate server `1.7.x` and `@restatedev/restate-sdk` `1.17.x` (pinned in `package.json`) —
check both when touching version pins; the SDK's own version numbering runs well ahead of the
server's, so "latest" is not the right default here.

## Runtime

- Requires Bun `>=1.4.0` or Node.js `>=26`, inherited from `@empyria/classification`'s use
  of native `Temporal`. Both `@empyria/classification` and `@empyria/common` are **git
  dependencies** — this package only sees their pushed commits, not local working-tree changes
  in sibling repos.
- Plain ESM, no TypeScript, no build step. The original `admin.ts`/`admin.types.ts`/`Caller.ts`
  (and the `generateTypes.sh` script that regenerated `admin.types.ts` from a live server's
  `/openapi` spec) have been removed — `lib/Admin.js`/`lib/Caller.js` are the canonical,
  hand-converted, tested equivalents. There is no generated-types workflow left in this repo;
  if the Admin API needs re-syncing, diff `lib/Admin.js`'s assumptions against a live server's
  `<admin-url>/openapi` by hand.
- Relative imports must include explicit `.js` extensions — Bun tolerates missing ones, Node's
  ESM resolver doesn't.

## Agent entry point (`lib/agent/`)

`lib/agent/` (merged in from the former `@empyria/restate-llm`) is exported only through
`@empyria/restate/agent` ([agent.js](./agent.js)), never from [index.js](./index.js). The AI
SDK packages (`ai`, `@ai-sdk/*`) are **optional** peer dependencies (and devDependencies for
the tests): a consumer that only uses Admin/Cron/Pubsub must be able to import the package
root without them installed. Never import `lib/agent/` from a root-exported module.

Agent tests use `fakeCtx` from `lib/testing/Fakes.js` (exported as `@empyria/restate/testing`; `test/agent/fakes.js` re-exports it), which mimics the journal's JSON round trip
and a bounded `ctx.run` turning an exhausted retry into a `TerminalError` — keep it in step
with the real SDK behaviour when touching either.

## Keep this package generic

Only things that are generic to Restate or to LLM agents belong here. Anything specific to one
consumer (its folder layout, its service names, its prompts, its UI) stays in that consumer. A consumer
that finds itself writing a generic helper should add it here with tests, release it, then bump its pin.

Journal discipline is enforced by the library, not left to each agent: step metadata is small numbers
only (never prompt or reply text), and tool arguments/results have byte caps (`Tools.js`). Keep both
true when touching `Loop.js` or `Tools.js`.

Block tools take `key(args, meta)` and `input(args, meta)` hooks (`meta.idempotencyKey` is unique per tool call); both must be
total, because an exception there is a non-terminal error that Restate would retry forever.

`defineAgent`'s `tools` may be a function of the request; it is evaluated outside `ctx.run` on every
replay, so it must stay pure. `test/agent/fakes.js`'s result helpers use the AI SDK's v4 result shape
(`finishReason: {unified, raw}`); the older plain-string form makes `generateText` report no finish reason.

## No official Admin API client

Verified directly against the published `@restatedev/restate-sdk`/`-clients` package
internals (both the line this repo targets and the latest available at the time):
zero Admin API exports. Only the ingress/invocation client and the service-authoring API
(`restate.service`/`object`/`workflow`) are official. `lib/Admin.js` fetches the Admin API's
REST endpoints directly — that's not a stopgap, it's the only way to do this today.

## Testing Restate service/object definitions

`restate.service({...})`/`restate.object({...})` do **not** return your handler functions
under `.handlers` — that property doesn't exist on the returned definition. The raw handler
functions are reachable at `.service` (for `restate.service`) or `.object` (for
`restate.object`), e.g. `cronJob.object.initiate(mockCtx, request)`. See `test/Cron.test.js`.

`@restatedev/restate-sdk-clients`'s `clients` export (re-exported from `lib/Admin.js`) is a
live ESM namespace binding — you cannot reassign `clients.connect` directly (`TypeError:
Attempted to assign to readonly property`). Use `mock.module('@restatedev/restate-sdk-clients',
() => ({...}))` instead, and capture the _real_ `connect` function once at module load (before
any mocking) if you need to restore it — reading it back off the live `clients` binding later
may observe an already-mocked value. See `test/Admin.test.js`.

`setupRestate`'s shutdown decision is `shouldDeleteOnShutdown` (unit tested); `keepDeploymentOnShutdown` and
`forceRegistration` exist because invocations are pinned to their deployment: Restate 1.7 keeps the deployment ID when the
same address registers again, but only `force: true` updates its handler list. Check both against a live server when
touching them.

`setupRestate` takes ONE complete `serviceURL` (scheme and explicit port included): it is registered as given and the
endpoint listens on its port. There is deliberately no `host` or `port` option — never assemble a URL from parts, the
scheme and any mapping are the caller's to state. `parseServiceURL` validates it (unit tested).
`createRestateAdmin().setupRestate` must forward every option to `setupRestate` — it once dropped
`keepDeploymentOnShutdown`/`forceRegistration`/`registrationCallbackFn`.

`setupRestate` (in `lib/Admin.js`) is not unit tested: it binds real HTTP/2 + health-check
ports, installs process-wide `SIGTERM`/`SIGINT` handlers, and its returned `forceClose` calls
`process.exit()` — none of which are safe to exercise in-process in a test run.

## Cron jobs

`CronJob.ensure` is the idempotent entry point (`ensureCronJob` is its ingress client). Never make a boot-time scheduler
with `CronJobInitiator.create`: it generates a new random job ID on every call, so each restart would add another copy.
`ensure` compares the normalised request (`cronExpression`, `service`, `method`, `key`, `payload`) and only reschedules
when it changed. A change here must keep `initiate`, `execute` and `cancel` behaving as before.

## Zero-dependency preference

Cron parsing uses `croner` (zero dependencies), not `cron-parser` (pulls in `luxon`). If you
touch `lib/Cron.js`'s scheduling logic: `new Cron(pattern)` without a callback just parses —
it does not start a timer — and `.nextRun(referenceDate)` is what gives a deterministic next
run time from Restate's replay-safe `ctx.date.now()`, matching the library's actual API rather
than `cron-parser`'s `CronExpressionParser.parse(...).next()` shape.

## Style

- Formatting is enforced by oxfmt ([.oxfmtrc.json](./.oxfmtrc.json)): tabs, single quotes, no
  semicolons, trailing commas. Run `bun run format:fix` before committing.
