import { Data } from "effect"

export class CliValidationError extends Data.TaggedError("CliValidationError")<{
  readonly message: string
}> {}
