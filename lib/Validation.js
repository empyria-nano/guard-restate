import { TerminalError } from '@restatedev/restate-sdk'
import { createValidator } from '@empyria/common'

/**
 * withValidation — higher-order function that wraps a Restate workflow handler
 * with AJV schema validation on both the input and the output.
 *
 * Why validate at this layer?
 * Restate deserialises the workflow payload from JSON and passes it directly to
 * the handler. Without explicit validation there is no guarantee the shape
 * matches what the handler expects — especially across service versions. By
 * validating here we get a clear, early error rather than a confusing runtime
 * failure deep inside business logic.
 *
 * The output schema acts as a contract check: if the handler returns something
 * that doesn't match the declared output type, the error is caught before
 * Restate records the result.
 *
 * Validation failures are thrown as `TerminalError`, never as the plain
 * `ValidationError` `@empyria/common` raises: Restate retries any non-terminal
 * error indefinitely, and a payload that failed validation once fails it on
 * every retry. Input failures carry errorCode 400 (the caller's fault), output
 * failures 500 (the handler's fault) — Restate propagates the code to an
 * ingress caller as the HTTP status. Errors thrown by `handler` itself are left
 * untouched, so transient failures there are still retried.
 *
 * Usage:
 *   handlers: {
 *     run: withValidation(InputSchema, OutputSchema, async (ctx, input) => { ... })
 *   }
 */
export function withValidation(inputSchema, outputSchema, handler) {
	const validateInput = createValidator(inputSchema)
	const validateOutput = createValidator(outputSchema)

	return async (ctx, input) => {
		const validatedInput = asTerminal(validateInput, input, 'input', 400)

		// Execute the actual workflow logic.
		const result = await handler(ctx, validatedInput)

		return asTerminal(validateOutput, result, 'output', 500)
	}
}

/**
 * Runs `validator(value)`, rethrowing any failure as a `TerminalError`.
 * @param {(value: *) => *} validator
 * @param {*} value
 * @param {'input'|'output'} side
 * @param {number} errorCode
 */
function asTerminal(validator, value, side, errorCode) {
	try {
		return validator(value)
	} catch (e) {
		throw new TerminalError(e.message, {
			errorCode,
			metadata: { validation: side, errorName: String(e.errorName ?? e.name) },
		})
	}
}
