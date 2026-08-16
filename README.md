# @empyria/restate

[Restate.dev](https://restate.dev) helpers for **Principia**, a nanoservice framework built
primarily on Bun: an Admin API client, a generic dynamic-dispatch service, cron-driven
workflow scheduling, and Restate-aware input/output schema validation.

Targets Restate server `1.7.x` and `@restatedev/restate-sdk` `1.6.x`.

## Requirements

- Bun `>=1.4.0` or Node.js `>=26`
- Plain ESM, no build step, no TypeScript

Both requirements come from [@empyria/classification](https://github.com/imrefazekas/empyria-classification)
and [@empyria/common](https://github.com/imrefazekas/empyria-common), which this package
depends on and which use the native `Temporal` global for all date/time handling.

## Install

```bash
bun add @empyria/restate
```

## Usage

```js
import { createRestateAdmin, withValidation, cronJob, cronJobInitiator } from '@empyria/restate'

const admin = createRestateAdmin({
	restateAdminURL: 'http://localhost:9070',
	restateURL: 'http://localhost:9071',
})

const services = await admin.listServices()
```

Everything is re-exported from the package root via [index.js](./index.js). Individual
modules under `lib/` can also be imported directly if you only need one:

```js
import { checkServiceHandler } from '@empyria/restate/lib/Admin.js'
```

## Modules

| Module                                   | Purpose                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [lib/Admin.js](./lib/Admin.js)           | Restate Admin API client — service/handler discovery, deployment registration and teardown, workflow/message dispatch, and `setupRestate` for wiring up an endpoint with health checks and graceful shutdown. |
| [lib/Caller.js](./lib/Caller.js)         | `CallerServiceDef` — a generic Restate service that dispatches a call to any handler on any other service by name, for when the target isn't known at compile time.                                           |
| [lib/Cron.js](./lib/Cron.js)             | `cronJobInitiator`/`cronJob` — Restate services implementing cron-driven, replay-safe recurring job scheduling on top of `croner`.                                                                            |
| [lib/Validation.js](./lib/Validation.js) | `withValidation` — wraps a workflow handler with input/output JSON schema validation via `@empyria/common`.                                                                                                   |

There is no official Restate Admin API client (verified directly against the published
`@restatedev/restate-sdk`/`-clients` packages) — `lib/Admin.js` is a hand-written wrapper kept
in sync with the live Admin API's OpenAPI spec (`<admin-url>/openapi`) by hand.

Every exported function is documented with JSDoc directly in its source file — hovering
a function in VSCode or Zed shows its parameters and return type without any extra
tooling, since both editors read JSDoc from plain `.js` files automatically.

Tests live under [test/](./test/), one file per module, separate from the sources. They
mock `fetch` and the Restate SDK client rather than requiring a live server — the one
exception is `setupRestate`, which binds real ports and installs process signal handlers
and is deliberately left untested (see [AGENTS.md](./AGENTS.md)).

## Scripts

```bash
bun run format       # check formatting (oxfmt)
bun run format:fix   # apply formatting
bun run lint         # lint (oxlint)
bun run lint:fix     # lint and fix
bun run test         # run tests with coverage
```

## License

MIT © Imre Fazekas
