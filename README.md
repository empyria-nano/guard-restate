# @empyria/restate

[Restate.dev](https://restate.dev) helpers for **Empyria**, a nanoservice framework built
primarily on Bun: an Admin API client, a generic dynamic-dispatch service, cron-driven
workflow scheduling, and Restate-aware input/output schema validation.

Targets Restate server `1.7.x` and `@restatedev/restate-sdk` `1.17.x`.

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

| Module                                   | Purpose                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [lib/Admin.js](./lib/Admin.js)           | Restate Admin API client — service/handler discovery, deployment registration and teardown, workflow/message dispatch, `defineWorkflow`/`defineService`/`defineObject` construct definers, and `setupRestate` for wiring up an endpoint with health checks and graceful shutdown.                      |
| [lib/Caller.js](./lib/Caller.js)         | `CallerServiceDef` — a generic Restate service that dispatches a call to any handler on any other service by name, for when the target isn't known at compile time.                                                                                                                                    |
| [lib/Cron.js](./lib/Cron.js)             | `cronJobInitiator`/`cronJob` — Restate services implementing cron-driven, replay-safe recurring job scheduling on top of `croner`.                                                                                                                                                                     |
| [lib/Pubsub.js](./lib/Pubsub.js)         | `definePubsub` (register a pubsub Virtual Object on your endpoint), `pubsubPublisher` (publish into it from inside a handler, in-process), `pubsubClient` (publish/pull/subscribe to it from anywhere else, over the network) — thin wrappers around `@restatedev/pubsub`/`@restatedev/pubsub-client`. |
| [lib/Validation.js](./lib/Validation.js) | `withValidation` — wraps a workflow handler with input/output JSON schema validation via `@empyria/common`.                                                                                                                                                                                            |
| [lib/Endpoint.js](./lib/Endpoint.js)     | `serveEndpoint` — serves services/workflows over HTTP/2 without registering itself or deleting its deployment on exit (for a supervisor that registers the address).                                                                                                                                   |

## Agents: `@empyria/restate/agent`

LLM agents as Restate building blocks (formerly `@empyria/restate-llm`). A separate entry
point, so the root import never loads the AI SDK. It needs the optional peer dependencies:

```bash
bun add ai @ai-sdk/openai-compatible @ai-sdk/provider
```

| Module                                       | Purpose                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [lib/agent/Agent.js](./lib/agent/Agent.js)   | `defineAgent` — builds the service/object and its `ask` handler: validated I/O, `loadContext` that journals only the skill index, session memory (object state or an external `historyStore`), step/token budgets, invocation retry policy. `createAgentService` is the deprecated `AgentService` shortcut. |
| [lib/agent/Loop.js](./lib/agent/Loop.js)     | `runAgentLoop` — one round at a time; every LLM call and tool call is its own durable step. Journals model responses, never prompts or prior history.                                                                                                                                                       |
| [lib/agent/Tools.js](./lib/agent/Tools.js)   | Tool specs and execution: block tools (`ctx.genericCall`), execute tools (bounded `ctx.run` with an idempotency key), approval through an awakeable with a timeout, `load_skill`, `final_answer`.                                                                                                           |
| [lib/agent/Skills.js](./lib/agent/Skills.js) | Skill bodies stay out of the journal: `load_skill` records `{name, sha256}`, and `expandSkillRefs` puts the body back inside each LLM step. A hash mismatch within one invocation is terminal; across session turns the current body is used.                                                               |
| [lib/agent/Errors.js](./lib/agent/Errors.js) | `toRestateLLMError` (AI SDK error → terminal / `RetryableError` / transient) and the default retry policies for LLM steps, tool steps and the agent invocation.                                                                                                                                             |
| [lib/agent/Model.js](./lib/agent/Model.js)   | `createModel` — AI SDK model for an OpenAI-compatible endpoint (e.g. Bifrost).                                                                                                                                                                                                                              |

### Recurring jobs

`cronJob` (a virtual object) runs a target handler on a cron schedule: each run sends the target, then schedules the
next one from the current time, so a restart or an outage never causes a backlog of runs. Register `cronJob` on your
endpoint, then create jobs with either:

- `cronJobInitiator.create(request)`: a new job with a random ID each call (good for jobs created by users);
- `ensureCronJob({restateURL, id, cronExpression, service, method, key?, payload?})`: **idempotent, for code that
  starts with the application.** The job has the stable `id` you give it, so calling it on every start never adds a second
  job: the same request changes nothing, and a changed request (another schedule, target or payload) replaces the pending
  run under the same ID. Call it once the endpoint has registered, e.g. from `setupRestate`'s `registrationCallbackFn`.

Cron expressions are `croner` patterns (five fields, or six with seconds for tests). The target handler is sent the
`payload` as its input, or no input when there is none.

### Serving and registering an endpoint

`setupRestate({ restateAdminURL, serviceURL: 'https://agent-service.internal:9080', services })` takes one complete URL, the
address Restate reaches the endpoint at. It is registered as given and the endpoint listens on its port (80 or 443 when
the URL has none or states the scheme's default), so the scheme is required (there is no separate host or port option);
pass `port` when the endpoint listens on another port than the one in the URL (a container behind a Service or proxy). The
health endpoint listens on the port after that unless `healthPort` is set.

It serves, registers the deployment, and deletes it again on SIGINT/SIGTERM. Invocations in flight are
pinned to their deployment, so deleting it strands them: a restarted process cannot finish them and they can only be
killed. For a process restarted at the same address, pass `keepDeploymentOnShutdown: true` and `forceRegistration: true`:
Restate keeps the deployment ID when the same address registers again (checked against Restate 1.7), running
invocations resume on the new process, and `force` updates the services and handlers in place (a plain
re-registration keeps the old handler list). Only compatible changes are safe this way: an invocation of a removed or
renamed handler cannot resume.

To serve without registering: when something else owns registration (a supervisor that registers a process's address once and restarts the process), use
`serveEndpoint({port, services})` instead: it only serves. Invocations already running on a deployment are pinned to its
address, so the deployment must survive the process stopping and come back at the same address.

### Shaping an agent

`defineAgent` options beyond the basics:

| Option                   | Does                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools` as a function    | `tools: (input) => ({...})` builds the tools from the validated request, for tools that depend on it. It runs outside any `ctx.run` on every execution and replay, so it must be pure. An invalid map fails that request terminally (500).                                                                                                                            |
| `output` as a function   | `output: (input) => schema \| undefined` chooses the answer's JSON Schema per request (same rules as `tools`: pure, no I/O); `undefined` means a free-text answer for that request. With any `output`, the model's answer is checked against the schema: a wrong one is handed back to the model to correct, and a model that never gets it right ends at `maxSteps`. |
| `respond(result, input)` | Shapes what `ask` returns from the loop result `{text, output?, steps, totalTokens, trace}`. Pair it with `responseSchema`, which validates the shaped value before Restate records it.                                                                                                                                                                               |
| `label(input)`           | A terminal failure then reads `[label] message`, so a failed run says what it was working on. Code and metadata are kept; cancellations, timeouts and retryable errors are untouched.                                                                                                                                                                                 |
| `limits.maxInputBytes`   | Largest request (JSON bytes, default 64 KB); a larger one is refused terminally (413).                                                                                                                                                                                                                                                                                |

**Keying block tools.** A block tool calls another Restate building block. Its `key(args, meta)` and `input(args, meta)`
hooks decide the target key and the parameter from the model's arguments and a per-call idempotency key
(`meta.idempotencyKey`, unique for every tool call). A key that is the same for several calls (e.g. `lock:<resource>`)
makes a virtual object run those calls one at a time and queue the rest durably; a key built from the idempotency key
makes every call independent. `input` adds what the model must not control, such as the caller or the allowed folder.
Both hooks must not throw: validate before the run, not inside them.

**Size caps on tool calls.** Tool arguments and results are journaled and replayed, so each tool has
`maxInputBytes` (default 16 KB) and `maxOutputBytes` (default 32 KB). Oversized arguments are not run and
the model is told why; an oversized result is replaced by an error the model sees. For an `execute` tool the
check happens inside its own `ctx.run`, so the big value is never recorded.

**What a run records.** Each `llm-step-N` journals a small `meta` (`model`, `finishReason`, `inputTokens`,
`outputTokens`, `durationMs`), never the prompt or the reply. The loop returns the same facts as `trace`
(one entry per step with the tool names asked for) and logs one `ctx.console` line per step, which stays
silent on replay.

**Configuration.** `readLlmEnv(process.env)` returns `{LLM_BASE_URL, LLM_API_KEY?, MODEL_ID}` and fails with a
terminal 500 that names the missing setting and never prints a value.

**Testing agents.** `@empyria/restate/testing` exports `fakeCtx` (a journaling `run`, `genericCall`,
`awakeable`, state and a capturing `console`) and the model-result helpers `textResult`, `toolCallResult`
and `sequence`, without loading the AI SDK.

Error policy: a tool that fails terminally (rejected or timed-out approval, a callee's
`TerminalError`, an execute tool out of retries) goes back to the model as an error result,
so the agent can adapt. Transient errors are left to Restate to retry, and cancellation
always propagates.

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
