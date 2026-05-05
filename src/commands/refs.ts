import { Console, Effect } from "effect"
import { getReferences, type RefsError } from "../refs.js"
import type { CliCommand } from "../parser.js"
import { SemanticScholarClient } from "../semanticScholar.js"

export const runRefsCommand = (
  command: Extract<CliCommand, { readonly tag: "refs" }>
): Effect.Effect<void, RefsError, SemanticScholarClient> =>
  getReferences(command).pipe(
    Effect.flatMap((output) => Console.log(output))
  )
