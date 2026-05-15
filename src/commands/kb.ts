import { Console, Effect } from "effect"
import { runKb, runKbIngestBatch, type KbEnvironment, type KbError } from "../kb.js"
import type { GetError } from "../get.js"
import type { CliCommand } from "../parser.js"

export const runKbCommand = (
  command: Extract<CliCommand, { readonly tag: `kb-${string}` }>
): Effect.Effect<void, KbError | GetError, KbEnvironment> => {
  if (command.tag === "kb-ingest-batch") {
    return runKbIngestBatch(command.rawIds)
  }
  return runKb(command).pipe(Effect.flatMap((output) => Console.log(output)))
}
