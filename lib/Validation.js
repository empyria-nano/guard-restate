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
 * Usage:
 *   handlers: {
 *     run: withValidation(InputSchema, OutputSchema, async (ctx, input) => { ... })
 *   }
 */
export function withValidation(inputSchema, outputSchema, handler) {
	const validateInput = createValidator(inputSchema)
	const validateOutput = createValidator(outputSchema)

	return async (ctx, input) => {
		// Validate input — throws ValidationError if the payload is malformed.
		const validatedInput = validateInput(input)

		// Execute the actual workflow logic.
		const result = await handler(ctx, validatedInput)

		// Validate output — guards against handler implementation drift.
		const validatedOutput = validateOutput(result)

		return validatedOutput
	}
}
