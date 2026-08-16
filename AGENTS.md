# AGENTS.md

Restate.dev helpers for **Empyria**, a nanoservice framework built primarily on Bun:
an Admin API client, a dynamic-dispatch service, cron-driven workflow scheduling, and
schema validation for workflow handlers.

Targets Restate server `1.7.x` and `@restatedev/restate-sdk` `1.6.x` — check both when
touching version pins; the SDK's own version numbering runs well ahead of the server's
(e.g. `1.16.x` was latest on npm when `1.6.x` was what this repo targets), so "latest"
is not the right default here.

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

## No official Admin API client

Verified directly against the published `@restatedev/restate-sdk`/`-clients` package
internals (both the `1.6.x` line this repo targets and the latest available at the time):
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

`setupRestate` (in `lib/Admin.js`) is not unit tested: it binds real HTTP/2 + health-check
ports, installs process-wide `SIGTERM`/`SIGINT` handlers, and its returned `forceClose` calls
`process.exit()` — none of which are safe to exercise in-process in a test run.

## Zero-dependency preference

Cron parsing uses `croner` (zero dependencies), not `cron-parser` (pulls in `luxon`). If you
touch `lib/Cron.js`'s scheduling logic: `new Cron(pattern)` without a callback just parses —
it does not start a timer — and `.nextRun(referenceDate)` is what gives a deterministic next
run time from Restate's replay-safe `ctx.date.now()`, matching the library's actual API rather
than `cron-parser`'s `CronExpressionParser.parse(...).next()` shape.

## Style

- Formatting is enforced by oxfmt ([.oxfmtrc.json](./.oxfmtrc.json)): tabs, single quotes, no
  semicolons, trailing commas. Run `bun run format:fix` before committing.
